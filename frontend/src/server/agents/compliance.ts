// The final compliance pass (spec §8.3): no buy, sell or target-price instruction survives into an answer, and
// the persona never speaks as the investor it is modelled on.

export const DISCLAIMER = "This is educational research, not investment advice. Consult a registered adviser before investing.";

const BANNED: RegExp[] = [
  /\b(buy|sell|hold|accumulate|book profits?|exit|add)\s+(this|the stock|the shares|these|now|at|before|into|on dips)\b/i,
  /\b(strong\s+)?(buy|sell)\s+(zone|signal|call|rating|recommendation)\b/i,
  /\b(price\s+)?target(s|ed)?\s+(of|price|is|at)\b|\btarget price\b/i,
  /\byou should (buy|sell|hold|invest|exit|book|avoid|consider buying)\b/i,
  /\b(i|we)\s+(recommend|advise|would buy|would sell|am buying|am selling|suggest (you|buying|selling))\b/i,
  /\bworth (buying|selling)\b|\bgood (buy|bet|investment) (now|at|today)\b|\b(a|an) (buy|sell)\b/i,
  /\b(must|should) (buy|sell|exit|invest|accumulate)\b/i,
  /\bguaranteed (returns?|profits?)\b|\bsure[- ]shot\b|\bmultibagger\b/i,
  /\b(will|is going to) (rise|fall|double|reach|hit|outperform)\b/i,
];

// "As Warren Buffett, I..." or an invented quotation.
const IMPERSONATION = /\b(as (warren buffett|peter lynch|buffett|lynch),? i\b|\bi,? (warren buffett|peter lynch)\b|(buffett|lynch) (once )?(said|says|would say)\s*[:,"“])/i;

const NEGATION = /\b(no|not|never|without|neither|nor|cannot|does not|is not|isn't|doesn't)\b[^.]{0,50}$/i;

export function violations(text: string): string[] {
  const out: string[] = [];
  for (const re of [...BANNED, IMPERSONATION]) {
    const hit = text.match(re);
    if (hit && !NEGATION.test(text.slice(0, hit.index ?? 0))) out.push(hit[0]);
  }
  return out;
}

/** Remove any sentence that reads as an instruction to trade or as the investor speaking. */
export function scrub(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const kept = sentences.filter((s) => {
    if (violations(s).length) {
      removed.push(s.trim());
      return false;
    }
    return true;
  });
  return { text: kept.join("").trim(), removed };
}

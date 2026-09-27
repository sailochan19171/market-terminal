// The amount an Indian filing writes out in words, next to the digits.
//
// A SEBI disclosure states the order value twice: "Rs. 217.56 Crore (Rupees Two Hundred Seventeen Crore Fifty Six
// Lakh only)". The digits are the part a reader of the PDF's text can get wrong - a two-column layout interleaves
// the rows, so "Rs. 217.56" ends up separated from the word "Crore" that gives it scale, and the figure comes back
// as 17.56 or as 217.56 lakh. The words survive that, because they carry their own scale and cannot be split from
// it without becoming nonsense.
//
// So the words are the check on the digits. Where the two disagree by more than rounding, the words win.

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
/** The Indian scale words, in rupees. */
const SCALE: Record<string, number> = { hundred: 100, thousand: 1_000, lakh: 100_000, lakhs: 100_000, lac: 100_000, lacs: 100_000, crore: 10_000_000, crores: 10_000_000 };

/**
 * "Two Hundred Seventeen Crore Fifty Six Lakh" -> 2_175_600_000 rupees.
 *
 * Indian numbering nests: each scale word closes the group of words before it, and the groups are added. Hundred
 * is the exception - it multiplies what came before it and stays inside the current group, so "two hundred
 * seventeen crore" is 217 crore rather than 200 crore plus 17.
 */
export function rupeesFromWords(words: string): number | null {
  const tokens = words.toLowerCase().replace(/[,&]/g, " ").replace(/\band\b/g, " ").split(/\s+/).filter(Boolean);
  let total = 0, group = 0, largest = 0, seen = false;
  for (const t of tokens) {
    const unit = UNITS[t];
    if (unit !== undefined) { group += unit; seen = true; continue; }
    const scale = SCALE[t];
    if (scale === undefined) continue;                      // "rupees", "only", "inclusive" and the like
    if (!seen) return null;                                  // a scale word with no number before it
    if (scale === 100) { group = (group || 1) * 100; continue; } // hundred stays inside the group
    if (scale > largest) {
      // A bigger scale than any before it closes over everything read so far: "five thousand four hundred
      // crore" is 5,400 crore, not five thousand plus four hundred crore.
      total = (total + group) * scale;
      largest = scale;
    } else {
      total += (group || 1) * scale;
    }
    group = 0;
  }
  const value = total + group;
  return seen && value > 0 ? value : null;
}

/**
 * The amount in words inside the brackets that follow a figure, in crore - or null when the filing did not write
 * one. `at` is where in the text the digits were found; only the bracket that follows them is read, so a second
 * amount elsewhere in the document cannot be mistaken for this one's spelling.
 */
export function wordsNear(text: string, at: number): number | null {
  // "(Rupees Two Hundred order(s)/contract(s); Seventeen Crore Fifty Six Lakh only)" - the form's own "(s)"
  // sits inside the amount when a two-column PDF interleaves the rows, and would otherwise close the bracket
  // after three words. Short parentheticals go first, so the amount reads as one piece.
  const window = text.slice(at, at + 320).replace(/\([^()]{0,12}\)/g, " ");
  const m = window.match(/\(\s*(?:indian\s+)?rupees?\s+([^)]{4,200})\)/i);
  if (!m) return null;
  const rupees = rupeesFromWords(m[1]);
  return rupees === null ? null : rupees / 1e7;
}

/**
 * The value to trust, given what the digits said and what the words next to them said. Within a rupee of each
 * other the digits stand, so an "approximately" rounded spelling does not overrule a precise figure. Beyond
 * that the words win, and the caller is told, because a disagreement that large is a misread of the digits.
 */
export function reconcile(fromDigits: number | null, fromWords: number | null): { value: number | null; corrected: boolean } {
  if (fromWords === null) return { value: fromDigits, corrected: false };
  if (fromDigits === null) return { value: fromWords, corrected: false };
  const off = Math.abs(fromDigits - fromWords);
  // Within 1%, or under a lakh apart on a small order: the same amount, written to different precision.
  if (off <= Math.max(0.01, fromWords * 0.01)) return { value: fromDigits, corrected: false };
  return { value: fromWords, corrected: true };
}

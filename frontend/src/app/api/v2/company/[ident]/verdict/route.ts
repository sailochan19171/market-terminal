// The valuation verdict (Lynch/PEGY and four other lenses), with the growth and discount-rate inputs the
// reader can change: ?growth=eps3y|eps5y|profit3y|blended|manual, ?growthPct=12.5, ?discountRate=0.11
import { identityOr404 } from "@/server/api/company";
import { valuationVerdict, type GrowthBasis } from "@/server/research/verdict";
import { ApiError, Args, badRequest, db, handle, json, type Ctx } from "@/server/api/common";

const BASES: GrowthBasis[] = ["blended", "analyst", "eps3y", "eps5y", "profit3y", "manual"];

export const GET = handle(async (req: Request, ctx: Ctx<{ ident: string }>) => {
  const d = db();
  const identity = identityOr404(d, decodeURIComponent((await ctx.params).ident));
  if (!identity.symbol) throw new ApiError(422, "The valuation models need NSE filings; this company is listed on BSE only.", { error: "no_data" });
  const a = Args.of(req);

  const growth = a.str("growth", "blended") as GrowthBasis;
  if (!BASES.includes(growth)) throw badRequest(`growth must be one of ${BASES.join(", ")}`);
  const rawPct = a.str("growthPct");
  const growthPct = rawPct === "" ? undefined : Number(rawPct);
  if (growthPct !== undefined && (!Number.isFinite(growthPct) || growthPct < -100 || growthPct > 200)) throw badRequest("growthPct must be a percentage between -100 and 200");
  const rawRate = a.str("discountRate");
  const discountRate = rawRate === "" ? undefined : Number(rawRate);
  if (discountRate !== undefined && (!Number.isFinite(discountRate) || discountRate <= 0.04 || discountRate > 0.4)) throw badRequest("discountRate must be a fraction above 0.04 and at most 0.4");

  return json(valuationVerdict(d, identity.symbol, { growth, growthPct, discountRate }), { shared: 900 });
});

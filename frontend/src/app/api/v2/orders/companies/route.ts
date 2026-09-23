// Orders won in a period as a share of each company's own revenue.
import { companyOrders } from "@/server/orders/query";
import { Args, db, handle, json } from "@/server/api/common";

export const GET = handle((req: Request) => {
  const a = Args.of(req);
  const months = a.int("months", 6, 1, 60);
  const maxCap = Number(a.str("maxMarketCap"));
  const rows = companyOrders(db(), {
    months,
    days: Number(a.str("days")) || null,
    from: a.date("from"),
    to: a.date("to"),
    minRevenuePct: Number(a.str("minRevenuePct")) || null,
    minMarketCapCr: Number(a.str("minMarketCap")) || null,
    maxMarketCapCr: Number.isFinite(maxCap) && maxCap > 0 ? maxCap : null,
    search: a.str("q") || null,
    limit: a.int("limit", 200, 1, 1000),
  });
  return json({ months, count: rows.length, rows }, { shared: 300 });
});

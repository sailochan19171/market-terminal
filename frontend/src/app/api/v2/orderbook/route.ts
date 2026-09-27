// The order book each company reports to its investors, with how fast it is growing.
import { orderBooks, orderBookSummary, topGainers, type OrderBookFilters } from "@/server/orders/orderBookQuery";
import { Args, db, handle, json } from "@/server/api/common";

export const GET = handle((req: Request) => {
  const a = Args.of(req);
  const conn = db();
  const filters: OrderBookFilters = {
    window: (["3m", "6m", "12m"] as const).find((w) => w === a.str("window")) ?? "3m",
    minBookCr: Number(a.str("minBookCr")) || 0,
    search: a.str("q") || null,
    sort: (["growth", "book", "updated"] as const).find((s) => s === a.str("sort")) ?? "updated",
    limit: a.int("limit", 500, 1, 2000),
  };
  return json({
    window: filters.window,
    summary: orderBookSummary(conn, filters),
    gainers: topGainers(conn, { ...filters, limit: 12 }),
    rows: orderBooks(conn, filters),
  }, { shared: 300 });
});

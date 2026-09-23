// Every order win read out of the announcement PDFs, with the filters the dashboard offers.
import { coverage } from "@/server/orders/store";
import { filterOptions, listOrders, type OrderFilters } from "@/server/orders/query";
import { Args, db, handle, json } from "@/server/api/common";

export const GET = handle((req: Request) => {
  const a = Args.of(req);
  const months = a.int("months", 6, 1, 60);
  // "today" and "this week" are shorter than the shortest month: they come as days.
  const days = Number(a.str("days")) || null;
  // A date range chosen in the calendar; either end may stand on its own.
  const from = a.date("from");
  const to = a.date("to");
  const conn = db();
  const filters: OrderFilters = {
    months, days, from, to,
    company: a.str("company") || null,
    customer: a.str("customer") || null,
    minOrderPct: Number(a.str("minOrderPct")) || null,
    minValueCr: Number(a.str("minValueCr")) || null,
    search: a.str("q") || null,
    sort: (["date", "value", "size"] as const).find((s) => s === a.str("sort")) ?? "date" as const,
    limit: a.int("limit", 200, 1, 2000),
    offset: a.int("offset", 0, 0, 100_000),
  };
  const { rows, total } = listOrders(conn, filters);
  return json({
    months, days, from, to, total, rows,
    options: filterOptions(conn, filters),
    coverage: coverage(conn),
  }, { shared: 300 });
});

import { summary } from "@/server/api/market";
import { Args, db, handle, json } from "@/server/api/common";

export const GET = handle((req: Request) => {
  const { status, data } = summary(db(), Args.of(req));
  return json(data, { status });
});

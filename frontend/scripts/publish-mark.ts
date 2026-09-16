// Set a publisher mark by hand, for a table added after the hosted snapshot was uploaded.
//
// The publisher only sends rows written after the mark it holds for a table, and a table with no mark is
// skipped entirely with a warning. Setting an empty mark makes the next publish send the whole table once.
//   npx tsx scripts/publish-mark.ts kb_doc ""            # send everything on the next publish
//   npx tsx scripts/publish-mark.ts                      # show the marks
import { openState } from "../src/server/jobs/publish";

const [table, mark] = process.argv.slice(2);
const state = openState();
if (!table) {
  for (const r of state.all<{ tbl: string; mark: string }>("SELECT tbl, mark FROM publish_mark ORDER BY tbl")) {
    console.log(`${r.tbl.padEnd(28)} ${r.mark || "(empty: the whole table goes next publish)"}`);
  }
} else {
  state.run("INSERT INTO publish_mark (tbl, mark) VALUES (?, ?) ON CONFLICT(tbl) DO UPDATE SET mark = excluded.mark", [table, mark ?? ""]);
  console.log(`${table}: mark set to ${mark ? mark : "(empty)"}`);
}
state.close();

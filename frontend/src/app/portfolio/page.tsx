"use client";

import { FileLock2, ShieldCheck, Upload } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { Donut, SignedBars } from "@/components/charts/Categorical";
import { DataTable } from "@/components/DataTable";
import { Badge, Button, Card, CardBody, CardHeader, ErrorNote, Loading, PageTitle, Pct, Segmented, Unavailable } from "@/components/ui";
import { useApi } from "@/lib/api";
import { num, tone } from "@/lib/format";

interface Holding {
  symbol: string; name: string | null; asset_type: string | null; account: string | null; exchange: string;
  quantity: number; avg_price: number | null; close: number | null; last_price: number | null;
  value: number; cost: number; gain: number | null; gain_pct: number | null; broker: string;
}
interface Portfolio { holdings: Holding[]; total_value: number; total_cost: number; gain: number; gain_pct: number | null; brokers: string[] }

const TYPE_LABEL: Record<string, string> = { equity: "Equity", mutual_fund: "Mutual fund", bond: "Bond" };

function typeOf(h: Holding) {
  if (h.asset_type) return h.asset_type;
  return h.exchange === "MF" ? "mutual_fund" : h.exchange === "BOND" ? "bond" : "equity";
}

function Message({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p className={msg.ok ? "text-sm text-up" : "text-sm text-down"}>{msg.text}</p>;
}

function CasImport({ onDone }: { onDone: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const upload = async () => {
    const f = file.current?.files?.[0];
    if (!f) { setMsg({ ok: false, text: "Choose your CAS PDF first." }); return; }
    if (!password) { setMsg({ ok: false, text: "Enter the statement password." }); return; }
    setBusy(true); setMsg(null);
    const body = new FormData();
    body.append("file", f);
    body.append("password", password);
    body.append("label", "cas");
    try {
      const res = await fetch("/api/portfolio/import-cas", { method: "POST", body });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? "Import failed");
      setMsg({ ok: true, text: `Imported ${out.written} holdings from a ${out.file_type} statement: ${out.equity} equities, ${out.mutual_fund} mutual funds, ${out.bond} bonds.` });
      if (file.current) file.current.value = "";
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setPassword("");
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><FileLock2 size={18} /> Import your complete portfolio (CAS)</span>}
        subtitle="A Consolidated Account Statement lists every demat account under your PAN across all brokers, plus mutual funds." />
      <CardBody className="space-y-4">
        <ol className="grid gap-3 text-sm text-slate-600 sm:grid-cols-3 dark:text-slate-300">
          <li className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50"><span className="font-semibold">1.</span> Request a CAS from <a className="text-indigo-600 underline" href="https://www.cdslindia.com/CAS/LoginCAS.aspx" target="_blank" rel="noopener noreferrer">CDSL</a>, <a className="text-indigo-600 underline" href="https://nsdlcas.nsdl.com/" target="_blank" rel="noopener noreferrer">NSDL</a>, <a className="text-indigo-600 underline" href="https://www.camsonline.com/Investors/Statements/Consolidated-Account-Statement" target="_blank" rel="noopener noreferrer">CAMS</a> or KFintech. It arrives by email as a PDF.</li>
          <li className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50"><span className="font-semibold">2.</span> The PDF is password-protected. For CDSL/NSDL it is usually your PAN; for CAMS, the password you set when requesting it.</li>
          <li className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50"><span className="font-semibold">3.</span> Upload it here. Equities, mutual funds and bonds are imported, and equities are added to your watchlist.</li>
        </ol>
        <div className="flex flex-wrap items-center gap-3">
          <input ref={file} type="file" accept="application/pdf,.pdf"
            className="text-sm file:mr-3 file:rounded-xl file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium dark:file:bg-slate-800" />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off"
            placeholder="Statement password"
            className="w-52 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900" />
          <Button variant="primary" onClick={upload} disabled={busy}><Upload size={15} /> {busy ? "Reading statement…" : "Import CAS"}</Button>
        </div>
        <Message msg={msg} />
        <p className="flex items-start gap-2 text-xs text-slate-500">
          <ShieldCheck size={14} className="mt-0.5 shrink-0 text-up" />
          Parsed locally by this app&apos;s own server. The password only unlocks the file in memory and is never saved; the PDF is deleted as soon as it is read.
        </p>
      </CardBody>
    </Card>
  );
}

function CsvImport({ onDone }: { onDone: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [broker, setBroker] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const upload = async () => {
    const f = file.current?.files?.[0];
    if (!f) { setMsg({ ok: false, text: "Choose a CSV exported from your broker first." }); return; }
    setBusy(true); setMsg(null);
    const body = new FormData();
    body.append("file", f);
    body.append("broker", broker || "manual");
    try {
      const res = await fetch("/api/portfolio/import", { method: "POST", body });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? "Import failed");
      setMsg({ ok: true, text: `Imported ${out.imported} holdings.` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Import a broker CSV" subtitle="Holdings export from Zerodha, Groww, Upstox, Angel One and most others. Columns are matched automatically." />
      <CardBody className="flex flex-wrap items-center gap-3">
        <input ref={file} type="file" accept=".csv,text/csv"
          className="text-sm file:mr-3 file:rounded-xl file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium dark:file:bg-slate-800" />
        <input value={broker} onChange={(e) => setBroker(e.target.value)} placeholder="Label, e.g. zerodha"
          className="w-44 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900" />
        <Button onClick={upload} disabled={busy}><Upload size={15} /> {busy ? "Importing…" : "Import CSV"}</Button>
        <Message msg={msg} />
      </CardBody>
    </Card>
  );
}

export default function PortfolioPage() {
  const { data, error, loading, reload } = useApi<Portfolio>("/api/portfolio");
  const [filter, setFilter] = useState<"all" | "equity" | "mutual_fund" | "bond">("all");
  const all = data?.holdings ?? [];
  const holdings = useMemo(() => all.filter((h) => filter === "all" || typeOf(h) === filter), [all, filter]);

  const byType = useMemo(() => {
    const m: Record<string, number> = {};
    for (const h of all) m[typeOf(h)] = (m[typeOf(h)] ?? 0) + (h.value || 0);
    return m;
  }, [all]);

  return (
    <>
      <PageTitle title="Portfolio" subtitle="Your holdings, valued at the latest exchange close or statement NAV. Imports stay on this machine." />
      {error && <Card><ErrorNote message={error} onRetry={reload} /></Card>}
      {loading && !data && <Card><Loading rows={8} /></Card>}

      {all.length > 0 && data && (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Current value", `₹${num(data.total_value)}`],
              ["Invested", data.total_cost ? `₹${num(data.total_cost)}` : "—"],
              ["Unrealised P&L", <span key="g" className={tone(data.gain)}>₹{num(data.gain)}</span>],
              ["Return", <Pct key="p" value={data.gain_pct} />],
            ].map(([k, v]) => (
              <Card key={String(k)}><CardBody><p className="text-sm text-slate-500">{k}</p><p className="tabular mt-1 text-2xl font-semibold">{v}</p></CardBody></Card>
            ))}
          </div>
          <div className="mb-6 grid gap-6 lg:grid-cols-3">
            <Card><CardHeader title="By asset type" /><CardBody>
              <Donut height={260} slices={Object.entries(byType).map(([k, v]) => ({ name: TYPE_LABEL[k] ?? k, value: data.total_value ? (v / data.total_value) * 100 : 0 }))} />
            </CardBody></Card>
            <Card><CardHeader title="Allocation" /><CardBody>
              <Donut height={260} slices={[...all].sort((a, b) => b.value - a.value).slice(0, 8).map((h) => ({ name: h.symbol.length > 14 ? (h.name ?? h.symbol).slice(0, 18) : h.symbol, value: data.total_value ? (h.value / data.total_value) * 100 : 0 }))} />
            </CardBody></Card>
            <Card><CardHeader title="Return by holding" /><CardBody>
              <SignedBars data={all.filter((h) => h.gain_pct != null).slice(0, 12).map((h) => ({ name: h.symbol.slice(0, 14), pct: h.gain_pct ?? 0 }))} labelKey="name" valueKey="pct" height={260} />
            </CardBody></Card>
          </div>
        </>
      )}

      <Card className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 sm:px-6">
          <div>
            <h2 className="text-lg font-semibold">Holdings</h2>
            {data?.brokers.length ? <p className="text-sm text-slate-500">Sources: {data.brokers.join(", ")}</p> : null}
          </div>
          {all.length > 0 && (
            <Segmented size="sm" value={filter} onChange={setFilter} options={[
              { value: "all", label: `All (${all.length})` }, { value: "equity", label: "Equity" },
              { value: "mutual_fund", label: "Mutual funds" }, { value: "bond", label: "Bonds" },
            ]} />
          )}
        </div>
        <div className="pt-3">
          {data && all.length === 0 ? (
            <CardBody><Unavailable title="No holdings yet" reason="Portfolio data lives with your depository and broker, not on the exchanges. Import a CAS statement for everything at once, or a broker CSV below." /></CardBody>
          ) : (
            <DataTable dense sortable searchable searchPlaceholder="Search holdings" rows={holdings} rowKey={(r) => `${r.symbol}-${r.exchange}-${r.broker}`} initialSort={{ key: "value", dir: "desc" }}
              columns={[
                { key: "symbol", label: "Holding", render: (r) => (
                  <div className="min-w-0 max-w-xs">
                    <div className="flex items-center gap-2">
                      {typeOf(r) === "equity" && r.exchange === "NSE"
                        ? <Link href={`/company/${r.symbol}`} className="font-semibold text-indigo-700 hover:underline dark:text-indigo-300">{r.symbol}</Link>
                        : <span className="truncate font-semibold">{typeOf(r) === "equity" ? r.symbol : (r.name ?? r.symbol)}</span>}
                      <Badge tone={typeOf(r) === "equity" ? "brand" : typeOf(r) === "mutual_fund" ? "up" : "amber"}>{TYPE_LABEL[typeOf(r)] ?? typeOf(r)}</Badge>
                    </div>
                    {r.account && <p className="truncate text-xs text-slate-400">{r.account}</p>}
                  </div>
                ) },
                { key: "quantity", label: "Qty / units", align: "right", render: (r) => num(r.quantity, typeOf(r) === "equity" ? 0 : 3) },
                { key: "avg_price", label: "Avg cost", align: "right", render: (r) => num(r.avg_price) },
                { key: "close", label: "Price / NAV", align: "right", sortValue: (r) => r.close ?? r.last_price, render: (r) => num(r.close ?? r.last_price) },
                { key: "value", label: "Value", align: "right", render: (r) => num(r.value) },
                { key: "gain", label: "P&L", align: "right", render: (r) => <span className={tone(r.gain)}>{num(r.gain)}</span> },
                { key: "gain_pct", label: "Return", align: "right", render: (r) => <Pct value={r.gain_pct} /> },
              ]} />
          )}
        </div>
      </Card>

      <div className="space-y-6">
        <CasImport onDone={reload} />
        <CsvImport onDone={reload} />
      </div>
    </>
  );
}

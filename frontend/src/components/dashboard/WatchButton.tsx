"use client";

import clsx from "clsx";
import { Star } from "lucide-react";
import { useEffect, useState } from "react";
import { api, post } from "@/lib/api";
import type { Identity } from "@/lib/dashboard";

/** Add or remove a company from the watchlist (NSE symbol, or BSE code for BSE-only companies). */
export function WatchButton({ identity }: { identity: Identity }) {
  const exchange = identity.symbol ? "NSE" : "BSE";
  const symbol = identity.symbol ?? identity.bseCode ?? identity.key;
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ watchlist: { symbol: string; scrip_cd: string | null; exchange: string }[] }>("/api/watchlist")
      .then((w) => alive && setOn(w.watchlist.some((x) => x.exchange === exchange && (x.symbol === symbol || x.scrip_cd === identity.bseCode))))
      .catch(() => alive && setOn(false));
    return () => { alive = false; };
  }, [exchange, symbol, identity.bseCode]);

  const toggle = async () => {
    setBusy(true);
    setFailed(null);
    try {
      if (on) {
        await api("/api/watchlist", { method: "DELETE", body: JSON.stringify({ symbol, exchange }) });
        setOn(false);
      } else {
        const r = await post<{ added: number; unknown: string[] }>("/api/watchlist", { symbols: [symbol], exchange });
        if (r.unknown?.length) throw new Error(`${symbol} is not recognised on ${exchange}`);
        setOn(true);
      }
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button onClick={toggle} disabled={on === null || busy} aria-pressed={Boolean(on)}
        className={clsx("inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold transition disabled:opacity-60",
          on ? "border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300"
             : "bg-indigo-600 text-white shadow-sm hover:bg-indigo-500")}>
        <Star size={15} fill={on ? "currentColor" : "none"} />
        {busy ? "Saving…" : on ? "On watchlist" : "Add to watchlist"}
      </button>
      {failed && <span role="alert" className="text-xs text-rose-600">{failed}</span>}
    </div>
  );
}

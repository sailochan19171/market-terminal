// One DataProvider interface for every market (spec §5): the agents never know which vendor answered.
import type { Db } from "../../db";
import { loadRawData } from "../data";
import type { Market, RawData } from "../state";
import { loadUs } from "./us";

export interface DataProvider {
  market: Market;
  name: string;
  /** Statements, prices, profile, filings and peers for one company, normalised to the internal schema. */
  load(db: Db, symbol: string, years: number): Promise<RawData>;
}

export const PROVIDERS: Record<Market, DataProvider> = {
  IN: { market: "IN", name: "NSE/BSE filings and bhavcopy", load: async (db, symbol, years) => loadRawData(db, symbol.replace(/\.(NS|BO)$/i, ""), years) },
  US: { market: "US", name: "SEC EDGAR and Nasdaq", load: (db, symbol, years) => loadUs(db, symbol, years) },
};

export const providerFor = (market: Market): DataProvider => PROVIDERS[market];

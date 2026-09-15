"use client";

import { Heatmap } from "@/components/market/Heatmap";
import { MarketOverview } from "@/components/market/MarketOverview";
import { PageTitle } from "@/components/ui";

export default function HeatmapPage() {
  return (
    <>
      <PageTitle title="Heatmap" subtitle="Every company in the chosen index, grouped by sector, sized by market cap and coloured by return." />
      <div className="space-y-6">
        <Heatmap height={720} />
        <MarketOverview height={620} />
      </div>
    </>
  );
}

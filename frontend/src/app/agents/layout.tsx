import type { Metadata } from "next";
import { AgentShell } from "@/components/agents/Shell";

export const metadata: Metadata = { title: "Analyst Agents" };

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  return <AgentShell>{children}</AgentShell>;
}

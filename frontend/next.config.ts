import type { NextConfig } from "next";

// The data API and background jobs run inside this app (src/app/api, src/server); there is no separate server.
const nextConfig: NextConfig = {
  // The app lives inside a larger directory that has its own lockfile.
  turbopack: { root: process.cwd() },
  // Lets a second build or dev server run beside the live one without sharing its output folder.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Loaded at runtime by Node rather than bundled: pdfjs ships its own worker and wasm files.
  serverExternalPackages: ["pdfjs-dist"],
  // Personas and scoring weights are YAML read at runtime (spec §3.9), so they travel with the functions that read them.
  outputFileTracingIncludes: {
    "/api/v2/agents/**": ["./config/**/*.yaml"],
  },
};

export default nextConfig;

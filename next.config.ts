import { resolve } from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(__dirname, ".."),
  },
  serverExternalPackages: ["unpdf", "pdfjs-dist"],
  experimental: {
    // Next.js 16's Clerk proxy (src/proxy.ts) buffers request bodies, with a
    // default 10MB cap. /api/files/parse allows uploads up to 50MB, and big
    // narrative PDFs (e.g. annual reports) routinely exceed 10MB. Raise the
    // proxy cap to match the route limit so the FormData isn't truncated
    // mid-upload — that truncation surfaces as "Failed to parse body as
    // FormData" because the multipart boundary gets cut off.
    proxyClientMaxBodySize: "50mb",
  },
};

export default nextConfig;

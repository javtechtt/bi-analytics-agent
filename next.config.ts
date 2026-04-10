import { resolve } from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(__dirname, ".."),
  },
  serverExternalPackages: ["unpdf", "pdfjs-dist"],
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/index",
          destination: "/price-index",
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;

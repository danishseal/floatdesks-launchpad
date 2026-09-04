import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "img.paragraph.com",
      },
      {
        protocol: "https",
        hostname: "paragraph.com",
      },
    ],
  },
};

export default nextConfig;

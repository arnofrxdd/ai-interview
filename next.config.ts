import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: '/ai-interview',
  trailingSlash: true,
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;

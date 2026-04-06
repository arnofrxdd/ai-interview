import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: '/ai-interview',
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;

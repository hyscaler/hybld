/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  serverExternalPackages: ["hybld", "@hybld/next", "@hybld/adapter-wordpress", "jiti"],
};

export default nextConfig;

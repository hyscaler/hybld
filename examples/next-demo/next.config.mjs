/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: this is the deployment mode hybld's Next backend targets.
  output: "export",
  // Required by the hybld Next backend: emitted paths become route/index.html.
  trailingSlash: true,
  images: { unoptimized: true },
  // The hybld helper graph runs in Node at build time; never bundle it.
  serverExternalPackages: ["hybld", "@hybld/next", "@hybld/adapter-wordpress", "jiti"],
};

export default nextConfig;

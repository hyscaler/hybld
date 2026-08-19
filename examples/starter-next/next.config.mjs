// The four settings hybld's Next backend requires.
const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  serverExternalPackages: ["hybld", "@hybld/next", "jiti"],
};
export default nextConfig;

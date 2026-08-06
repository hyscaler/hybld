export const metadata = {
  title: "Next Demo (hybld)",
  description: "hybld incremental builds on Next.js static export",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ maxWidth: 720, margin: "0 auto", fontFamily: "system-ui, sans-serif", padding: 16 }}>
        <header style={{ borderBottom: "1px solid #ddd", paddingBottom: 8, marginBottom: 16 }}>
          <a href="/" style={{ textDecoration: "none", color: "inherit" }}>
            <strong>Next Demo (hybld)</strong>
          </a>
        </header>
        {children}
      </body>
    </html>
  );
}

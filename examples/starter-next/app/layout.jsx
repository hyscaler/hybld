import "./globals.css";

export const metadata = {
  robots: { index: false }, // demo content; drop for your own site
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="inner">
            <a className="brand" href="/">hy<b>bld</b> starter</a>
            <span className="header-note">incremental static builds, live API</span>
          </div>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          Built page by page with hybld. Content belongs to its original publisher.
        </footer>
      </body>
    </html>
  );
}

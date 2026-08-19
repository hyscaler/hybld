export const metadata = {
  robots: { index: false }, // demo content; drop for your own site
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ font: "16px/1.6 system-ui, sans-serif", maxWidth: "44rem", margin: "2rem auto", padding: "0 1rem" }}>
        {children}
      </body>
    </html>
  );
}

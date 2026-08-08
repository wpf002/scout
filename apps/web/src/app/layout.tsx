import type { Metadata } from "next";
import Link from "next/link";
import { OperatorToken } from "@/components/OperatorToken";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scout",
  description: "Tiered OSINT investigation platform — a launcher, not an aggregator.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="brand">
              Scout<span>launcher, not aggregator</span>
            </Link>
            <nav className="nav">
              <Link href="/">Cases</Link>
              <Link href="/sources">Sources</Link>
              <OperatorToken />
            </nav>
          </div>
        </header>
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}

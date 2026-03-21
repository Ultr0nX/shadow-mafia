import type { Metadata } from "next";
import "./globals.css";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "Shadow Mafia — Private On-Chain Social Deduction",
  description:
    "The first provably private social deduction game on Solana. Hidden roles powered by Intel TDX Private Ephemeral Rollups.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-white min-h-screen font-mono">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

const geist = Geist({ subsets: ["latin", "latin-ext"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Atlas: the cheapest getaways from wherever you are",
  description:
    "Real return prices from your nearest airports, anywhere on earth, searched on Kiwi.com every night. Hidden gems, what to do there, the weather, and every place within ten hours by plane, train, coach or ferry.",
  metadataBase: new URL("https://atlas-kappa-wheat.vercel.app"),
  openGraph: {
    title: "Atlas: the cheapest getaways from wherever you are",
    description: "Tonight's cheapest return flights from your airports, with booking links. Searched every night.",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: "#05070e",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

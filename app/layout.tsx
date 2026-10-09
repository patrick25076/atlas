import type { Metadata, Viewport } from "next";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Atlas: cheapest getaways from where you are",
  description:
    "Real return prices for the next six weeks from Bucharest, Cluj, Iași and Timișoara, every place within ten hours by plane, train, coach or ferry, and what it is like there.",
  metadataBase: new URL("https://atlas-kappa-wheat.vercel.app"),
  openGraph: {
    title: "Atlas: cheapest getaways from where you are",
    description: "Venice, Milan, Tirana, Bologna from €32 return. Searched on Kiwi.com every night.",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: "#07090f",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

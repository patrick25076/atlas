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

// Travelpayouts Drive: verifies the site and turns outbound booking links into commission
// links on click. Their snippet, verbatim, in the head of every page (SETUP.md §2).
const TRAVELPAYOUTS_DRIVE = `(function () {
      var script = document.createElement("script");
      script.async = 1;
      script.setAttribute("data-cmp-ab","2");
      script.src = 'https://emrldtp.com/NTgzNzIw.js?t=583720';
      document.head.appendChild(script);
  })();`;

// The snippet is registered for the production host only: on localhost it logs "config is
// not valid" and a 403 on every page load, so development and preview builds leave it out.
// On Vercel VERCEL_ENV says which build this is; elsewhere NODE_ENV is the only signal.
const LOAD_DRIVE = process.env.VERCEL_ENV ? process.env.VERCEL_ENV === "production" : process.env.NODE_ENV === "production";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <head>{LOAD_DRIVE && <script data-cmp-ab="2" data-cfasync="false" dangerouslySetInnerHTML={{ __html: TRAVELPAYOUTS_DRIVE }} />}</head>
      <body>{children}</body>
    </html>
  );
}

import type { MetadataRoute } from "next";

// Installable on a phone: "Add to Home Screen" gives a full-screen globe.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Atlas: cheapest getaways from where you are",
    short_name: "Atlas",
    description: "Real return prices for the next six weeks, every place within ten hours, and what it is like there.",
    start_url: "/",
    display: "standalone",
    background_color: "#07090f",
    theme_color: "#07090f",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}

"use client";

import dynamic from "next/dynamic";

export type LocationHint = { lat: number; lon: number; label: string };

// MapLibre and deck.gl need the browser; never render the globe on the server.
const Globe = dynamic(() => import("@/components/Globe"), {
  ssr: false,
  loading: () => <div className="loading">Spinning up the globe</div>,
});

export default function GlobeLoader({ hint }: { hint: LocationHint | null }) {
  return <Globe hint={hint} />;
}

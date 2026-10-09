"use client";

import dynamic from "next/dynamic";

// MapLibre and deck.gl need the browser; never render the globe on the server.
const Globe = dynamic(() => import("@/components/Globe"), {
  ssr: false,
  loading: () => <div className="loading">Spinning up the globe</div>,
});

export default function Page() {
  return <Globe />;
}

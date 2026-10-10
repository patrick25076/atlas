"use client";

import { useEffect } from "react";

// The route-level error boundary: a render or data error inside the page lands here instead
// of a blank screen. The root layout (fonts, globals.css) still wraps it, so the app's own
// classes apply. "Try again" re-renders the segment; "Reload" starts the page over.
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="errorpage">
      <div className="errorbox" role="alert">
        <h1>Atlas hit a snag</h1>
        <p>{error.message || "Something went wrong while drawing the page."}</p>
        {error.digest && <p className="sub">Reference {error.digest}</p>}
        <div className="chips">
          <button className="chip on" onClick={() => reset()}>
            Try again
          </button>
          <button className="chip ghost" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    </main>
  );
}

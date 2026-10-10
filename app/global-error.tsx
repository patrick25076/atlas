"use client";

import { useEffect } from "react";
import "./globals.css";

// The last-resort boundary: it replaces the root layout when the layout itself throws, so it
// must render its own html and body, and brings the stylesheet along. The colours are inlined
// too, in case the stylesheet is what failed.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#05070e", color: "#eef2ff", fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Inter, Roboto, sans-serif" }}>
        <main className="errorpage" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
          <div className="errorbox" role="alert" style={{ maxWidth: 440, width: "100%", display: "flex", flexDirection: "column", gap: 12, padding: 22, borderRadius: 22, background: "rgba(14, 18, 32, 0.78)", border: "1px solid rgba(255, 255, 255, 0.09)" }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 650 }}>Atlas could not start</h1>
            <p style={{ margin: 0, color: "rgba(238, 242, 255, 0.64)", lineHeight: 1.45, wordBreak: "break-word" }}>{error.message || "Something went wrong before the page could draw."}</p>
            {error.digest && <p className="sub" style={{ margin: 0, color: "rgba(238, 242, 255, 0.4)", fontSize: 13 }}>Reference {error.digest}</p>}
            <div className="chips" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="chip on" onClick={() => reset()} style={{ font: "inherit", padding: "8px 14px", borderRadius: 999, border: "1px solid #6ff0c4", background: "#6ff0c4", color: "#04261b", cursor: "pointer", fontWeight: 600 }}>
                Try again
              </button>
              <button className="chip ghost" onClick={() => window.location.reload()} style={{ font: "inherit", padding: "8px 14px", borderRadius: 999, border: "1px solid rgba(255, 255, 255, 0.16)", background: "transparent", color: "#eef2ff", cursor: "pointer", fontWeight: 600 }}>
                Reload
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}

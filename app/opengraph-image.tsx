import { ImageResponse } from "next/og";
import dealsJson from "@/public/data/deals.json";
import type { DealsFile } from "@/lib/types";

// The picture a shared link shows: tonight's cheapest getaways, rebuilt on every deploy.
export const alt = "Atlas: the cheapest getaways from where you are";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  const file = dealsJson as unknown as DealsFile;
  const seen = new Set<string>();
  const top = file.deals.filter((d) => d.gw === "OTP" && !seen.has(d.dstCity) && seen.add(d.dstCity)).slice(0, 5);
  const updated = file.updated ? new Date(file.updated).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 56,
          background: "linear-gradient(135deg, #07090f 0%, #0d1424 60%, #1a1206 100%)",
          color: "#e9edf5",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 28, letterSpacing: 8, color: "#ffb454", fontWeight: 700 }}>ATLAS</div>
          <div style={{ fontSize: 54, fontWeight: 700, marginTop: 12 }}>Cheapest getaways from Bucharest</div>
          <div style={{ fontSize: 26, color: "#8d96aa", marginTop: 8 }}>{`Return flights, next six weeks, real prices${updated ? ` · searched ${updated}` : ""}`}</div>
        </div>
        <div style={{ display: "flex", gap: 18 }}>
          {top.map((d) => (
            <div
              key={d.dstCity}
              style={{
                display: "flex",
                flexDirection: "column",
                padding: "18px 22px",
                borderRadius: 18,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)",
                minWidth: 190,
              }}
            >
              <div style={{ fontSize: 40, fontWeight: 800, color: "#ffb454" }}>{`€${d.price}`}</div>
              <div style={{ fontSize: 28, fontWeight: 600 }}>{d.city}</div>
              <div style={{ fontSize: 18, color: "#8d96aa" }}>{`${d.nights} nights · ${d.stops ? `${d.stops} stop` : "direct"}`}</div>
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size },
  );
}

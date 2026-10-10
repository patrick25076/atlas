import { ImageResponse } from "next/og";
import { dealsFor } from "@/lib/deals-source";

// The picture a shared link shows: tonight's cheapest getaways from Bucharest, read from the
// stored board at request time and cached an hour.
export const alt = "Atlas: the cheapest getaways from wherever you are";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 3600;

export default async function Image() {
  const file = await dealsFor(["OTP"]);
  const seen = new Set<string>();
  const top = file.deals.filter((d) => !seen.has(d.dstCity) && seen.add(d.dstCity)).slice(0, 5);
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
          background: "linear-gradient(135deg, #05070e 0%, #0c1328 60%, #06261f 100%)",
          color: "#eef2ff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 30, color: "#6ff0c4", fontWeight: 700 }}>atlas.</div>
          <div style={{ fontSize: 54, fontWeight: 700, marginTop: 12 }}>Cheapest getaways from Bucharest</div>
          <div style={{ fontSize: 26, color: "#9aa3b8", marginTop: 8 }}>{`Return flights, next six weeks, real prices${updated ? ` · searched ${updated}` : ""}`}</div>
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
              <div style={{ fontSize: 40, fontWeight: 800, color: "#6ff0c4" }}>{`€${d.price}`}</div>
              <div style={{ fontSize: 28, fontWeight: 600 }}>{d.city}</div>
              <div style={{ fontSize: 18, color: "#9aa3b8" }}>{`${d.nights} nights · ${d.stops ? `${d.stops} stop` : "direct"}`}</div>
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size },
  );
}

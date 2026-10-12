"use client";

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";

// A flat map for the engine room: dots for places, lines for flights and trains. The same tiles as the globe, no
// globe projection, no animation: it is for reading, not for show.

export type MapDot = { id: string; lat: number; lon: number; label?: string; color?: string; size?: number };
export type MapLine = { id: string; from: [number, number]; to: [number, number]; color?: string; width?: number; dashed?: boolean; opacity?: number };

const STYLE = "https://tiles.openfreemap.org/styles/dark";
if (typeof window !== "undefined") maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

const lineFeature = (l: MapLine) => ({ type: "Feature" as const, properties: { color: l.color ?? "#7cc4ff", width: l.width ?? 1.5, dashed: l.dashed ? 1 : 0, opacity: l.opacity ?? 0.85 }, geometry: { type: "LineString" as const, coordinates: [l.from, l.to] } });
const dotFeature = (d: MapDot) => ({ type: "Feature" as const, properties: { color: d.color ?? "#6ff0c4", size: d.size ?? 5, label: d.label ?? "" }, geometry: { type: "Point" as const, coordinates: [d.lon, d.lat] } });

export default function AdminMap({ dots, lines, height = 360, fitKey }: { dots: MapDot[]; lines: MapLine[]; height?: number; fitKey?: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const latest = useRef({ dots, lines });
  latest.current = { dots, lines };

  const draw = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const { dots: d, lines: l } = latest.current;
    (m.getSource("lines") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: l.map(lineFeature) });
    (m.getSource("dots") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: d.map(dotFeature) });
  };

  useEffect(() => {
    if (!box.current) return;
    const m = new maplibregl.Map({ container: box.current, style: STYLE, center: [60, 25], zoom: 1.2, attributionControl: { compact: true } });
    map.current = m;
    m.on("load", () => {
      m.addSource("lines", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addSource("dots", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "lines", type: "line", source: "lines", paint: { "line-color": ["get", "color"], "line-width": ["get", "width"], "line-opacity": ["get", "opacity"] }, filter: ["==", ["get", "dashed"], 0] });
      m.addLayer({ id: "lines-dashed", type: "line", source: "lines", paint: { "line-color": ["get", "color"], "line-width": ["get", "width"], "line-opacity": ["get", "opacity"], "line-dasharray": [2, 2] }, filter: ["==", ["get", "dashed"], 1] });
      m.addLayer({ id: "dots", type: "circle", source: "dots", paint: { "circle-color": ["get", "color"], "circle-radius": ["get", "size"], "circle-stroke-color": "#05070e", "circle-stroke-width": 1 } });
      m.addLayer({ id: "labels", type: "symbol", source: "dots", layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-font": ["Noto Sans Regular"] }, paint: { "text-color": "#eef2ff", "text-halo-color": "#05070e", "text-halo-width": 1.2 } });
      ready.current = true;
      draw();
    });
    return () => {
      ready.current = false;
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(draw, [dots, lines]);

  // Frame what is drawn when the question changes (fitKey), not on every new line of a stream.
  useEffect(() => {
    const m = map.current;
    const pts = [...dots.map((d) => [d.lon, d.lat] as [number, number]), ...lines.flatMap((l) => [l.from, l.to])].filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && !(x === 0 && y === 0));
    if (!m || pts.length < 2) return;
    const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
    for (const p of pts) b.extend(p);
    const go = () => m.fitBounds(b, { padding: 40, maxZoom: 6, duration: 600 });
    if (ready.current) go();
    else m.once("load", go);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  return <div ref={box} style={{ height, width: "100%", borderRadius: 14, overflow: "hidden", border: "1px solid var(--line)" }} />;
}

"use client";

import { useEffect, useRef } from "react";
import type * as maplibregl from "maplibre-gl";
import { haversineKm } from "@/lib/geo";

// Tags on the globe, as real HTML pinned to map points: crisp at any zoom, styled with CSS,
// and placed greedily (hot ones first, then in list order) so that tags never overlap. They
// follow the map on every frame through the map's own events, without touching React state.
// Kinds: a price on a deal city, a numbered stop of a trip, a region to pick, a long-stay base.
export type LabelKind = "price" | "stop" | "region" | "base";
export type LabelItem = { key: string; lon: number; lat: number; text: string; hot?: boolean; cheap?: boolean; kind?: LabelKind; sub?: string };

type Props = {
  map: maplibregl.Map | null;
  items: LabelItem[];
  onPick: (key: string) => void;
  onHover: (key: string | null) => void;
};

export default function PriceLabels({ map, items, onPick, onHover }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    if (!map || !root.current) return;
    const el = root.current;
    const place = () => {
      const list = itemsRef.current;
      const center = map.getCenter();
      const zoom = map.getZoom();
      // On the globe a point more than ~85° from the centre is on the far side, and project()
      // still returns a screen position for it. Zoomed in, the viewport is far smaller than
      // that anyway, so the same limit holds at every zoom.
      const horizonKm = 9_400;
      const placed: { x: number; y: number; w: number; h: number }[] = [];
      const nodes = el.children as HTMLCollectionOf<HTMLElement>;
      const width = el.clientWidth;
      const height = el.clientHeight;
      // The panel is glass: a tag under it would show through. On desktop it covers the left
      // edge, on a phone the bottom sheet covers everything below its top edge.
      const left = width > 720 ? 500 : 20;
      const sheetTop = width <= 720 ? (el.parentElement?.querySelector(".panel")?.getBoundingClientRect().top ?? height) : height;
      const bottom = Math.min(height - 10, sheetTop - 6);
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        const node = nodes[i];
        if (!node) break;
        // Region tags fade out once you are close enough to see the countries themselves.
        let ok = haversineKm(center.lat, center.lng, it.lat, it.lon) < horizonKm && !(it.kind === "region" && zoom > 5.5);
        let x = 0;
        let y = 0;
        const w = node.offsetWidth || 46;
        const h = node.offsetHeight || 24;
        if (ok) {
          const p = map.project([it.lon, it.lat]);
          x = p.x;
          y = p.y - (it.kind === "region" ? 0 : 14);
          ok = x > left && x < width - 20 && y > 60 && y < bottom;
        }
        if (ok && !it.hot) {
          for (const q of placed) {
            if (Math.abs(q.x - x) < (q.w + w) / 2 + 4 && Math.abs(q.y - y) < (q.h + h) / 2 + 2) {
              ok = false;
              break;
            }
          }
        }
        if (ok) {
          placed.push({ x, y, w, h });
          node.style.transform = it.kind === "region" ? `translate(${x}px, ${y}px) translate(-50%, -50%)` : `translate(${x}px, ${y}px) translate(-50%, -100%)`;
          node.style.opacity = "1";
          node.style.pointerEvents = "auto";
        } else {
          node.style.opacity = "0";
          node.style.pointerEvents = "none";
        }
      }
    };
    place();
    map.on("render", place);
    map.on("resize", place);
    return () => {
      map.off("render", place);
      map.off("resize", place);
    };
  }, [map, items]);

  return (
    <div ref={root} className="labels" aria-hidden="true">
      {items.map((it) => (
        <button
          key={it.key}
          className={`tag ${it.kind ?? "price"}${it.hot ? " hot" : ""}${it.cheap ? " cheap" : ""}`}
          style={{ opacity: 0 }}
          onClick={() => onPick(it.key)}
          onMouseEnter={() => onHover(it.key)}
          onMouseLeave={() => onHover(null)}
          tabIndex={-1}
        >
          {it.text}
          {it.sub && <small>{it.sub}</small>}
        </button>
      ))}
    </div>
  );
}

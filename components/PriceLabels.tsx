"use client";

import { useEffect, useRef } from "react";
import type * as maplibregl from "maplibre-gl";
import { haversineKm } from "@/lib/geo";

// Price tags on the globe, as real HTML pinned to map points: crisp at any zoom, styled with
// CSS, and placed greedily (cheapest first) so that tags never overlap. They follow the map
// on every frame through the map's own events, without touching React state.
export type LabelItem = { key: string; lon: number; lat: number; text: string; hot?: boolean; cheap?: boolean };

type Props = {
  map: maplibregl.Map | null;
  items: LabelItem[];
  onPick: (key: string) => void;
  onHover: (key: string | null) => void;
};

const W = 46;
const H = 24;

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
      // On the globe, a point more than ~80° from the centre is on the far side.
      const horizonKm = zoom < 4 ? 8_600 : 20_000;
      const placed: { x: number; y: number }[] = [];
      const nodes = el.children as HTMLCollectionOf<HTMLElement>;
      const width = el.clientWidth;
      const height = el.clientHeight;
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        const node = nodes[i];
        if (!node) break;
        let ok = haversineKm(center.lat, center.lng, it.lat, it.lon) < horizonKm;
        let x = 0;
        let y = 0;
        if (ok) {
          const p = map.project([it.lon, it.lat]);
          x = p.x;
          y = p.y - 14;
          ok = x > 20 && x < width - 20 && y > 60 && y < height - 10;
        }
        if (ok && !it.hot) {
          for (const q of placed) {
            if (Math.abs(q.x - x) < W && Math.abs(q.y - y) < H) {
              ok = false;
              break;
            }
          }
        }
        if (ok) {
          placed.push({ x, y });
          node.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
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
          className={`tag${it.hot ? " hot" : ""}${it.cheap ? " cheap" : ""}`}
          style={{ opacity: 0 }}
          onClick={() => onPick(it.key)}
          onMouseEnter={() => onHover(it.key)}
          onMouseLeave={() => onHover(null)}
          tabIndex={-1}
        >
          {it.text}
        </button>
      ))}
    </div>
  );
}

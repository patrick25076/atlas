"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import { ArcLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Layer, PickingInfo } from "@deck.gl/core";
import { flightMinutes, formatDuration, haversineKm, nearestGateways } from "@/lib/geo";
import type { Airport, Destination, Gateway, Manifest, Route } from "@/lib/types";
import Panel, { BANDS, type Band } from "./Panel";

// The bundler cannot resolve MapLibre's worker from import.meta.url; see scripts/copy-worker.mjs.
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

const STYLE = "https://tiles.openfreemap.org/styles/dark";
const PANEL_PADDING = { left: 380, top: 60, right: 60, bottom: 60 };

export type Origin = { lat: number; lon: number; label: string; source: "gps" | "default" | "search" };
const DEFAULT_ORIGIN: Origin = { lat: 45.6579, lon: 25.6012, label: "Brașov", source: "default" };

type RGBA = [number, number, number, number];
export function arcColor(min: number): RGBA {
  if (min < 120) return [76, 201, 240, 200];
  if (min < 300) return [255, 180, 84, 200];
  return [255, 107, 107, 180];
}

const regionNames = typeof Intl !== "undefined" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;
export function countryName(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

function tooltip(info: PickingInfo): null | { html: string; style: Record<string, string> } {
  const o = info.object as Destination | Gateway | Origin | undefined;
  if (!o) return null;
  let html: string;
  if ("from" in o) {
    const where = [o.airport.city, countryName(o.airport.country)].filter(Boolean).join(", ");
    html = `<span class="code">${o.airport.iata}</span> ${where}<br/>~${formatDuration(flightMinutes(o.km))} flight · ${Math.round(o.km)} km · ${o.airlines} airline${o.airlines === 1 ? "" : "s"} (2014 network)`;
  } else if ("driveMin" in o) {
    html = `<span class="code">${o.airport.iata}</span> ${o.airport.name}<br/>${formatDuration(o.driveMin)} drive · ${Math.round(o.km)} km`;
  } else {
    html = `You are here (${o.source})`;
  }
  return {
    html,
    style: {
      background: "rgba(10,14,24,0.92)",
      color: "#e9edf5",
      fontSize: "12px",
      lineHeight: "1.35",
      padding: "8px 10px",
      borderRadius: "10px",
      border: "1px solid rgba(255,255,255,0.08)",
      maxWidth: "260px",
    },
  };
}

export default function Globe() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapLibreOverlay | null>(null);
  const spinRef = useRef(true);

  const [airports, setAirports] = useState<Airport[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [gatewayIata, setGatewayIata] = useState<string | null>(null);
  const [band, setBand] = useState<Band>("all");
  const [selectedDest, setSelectedDest] = useState<string | null>(null);

  // Static data, produced by scripts/ingest and committed under public/data.
  useEffect(() => {
    const load = (f: string) => fetch(`/data/${f}`).then((r) => r.json());
    Promise.all([load("airports.json"), load("routes-openflights.json"), load("manifest.json")]).then(
      ([a, r, m]) => {
        setAirports(a);
        setRoutes(r);
        setManifest(m);
      },
    );
  }, []);

  // Where the user is. Falls back to a fixed city so the globe always has a story to tell.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setOrigin(DEFAULT_ORIGIN);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => setOrigin({ lat: p.coords.latitude, lon: p.coords.longitude, label: "your location", source: "gps" }),
      () => setOrigin(DEFAULT_ORIGIN),
      { timeout: 8000, maximumAge: 600_000 },
    );
  }, []);

  const byIata = useMemo(() => new Map(airports.map((a) => [a.iata, a])), [airports]);
  const routesFrom = useMemo(() => {
    const m = new Map<string, Route[]>();
    for (const r of routes) {
      const list = m.get(r.src);
      if (list) list.push(r);
      else m.set(r.src, [r]);
    }
    return m;
  }, [routes]);

  const gateways = useMemo<Gateway[]>(
    () => (origin ? nearestGateways(airports, origin.lat, origin.lon) : []),
    [airports, origin],
  );

  const routeCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const g of gateways) out[g.airport.iata] = routesFrom.get(g.airport.iata)?.length ?? 0;
    return out;
  }, [gateways, routesFrom]);

  // Default gateway: within 45 minutes of the nearest usable airport, take the one with the most
  // routes. A hub 10 minutes further beats a regional field with three flights a week.
  useEffect(() => {
    if (!gateways.length || gateways.some((g) => g.airport.iata === gatewayIata)) return;
    const usable = gateways.filter((g) => routeCounts[g.airport.iata] > 0);
    if (!usable.length) {
      setGatewayIata(gateways[0].airport.iata);
      return;
    }
    const nearest = Math.min(...usable.map((g) => g.driveMin));
    const best = usable
      .filter((g) => g.driveMin <= nearest + 45)
      .sort((a, b) => routeCounts[b.airport.iata] - routeCounts[a.airport.iata])[0];
    setGatewayIata(best.airport.iata);
  }, [gateways, gatewayIata, routeCounts]);

  const gateway = gatewayIata ? (byIata.get(gatewayIata) ?? null) : null;

  const destinations = useMemo<Destination[]>(() => {
    if (!gateway) return [];
    const out: Destination[] = [];
    for (const r of routesFrom.get(gateway.iata) ?? []) {
      const airport = byIata.get(r.dst);
      if (!airport) continue;
      out.push({ airport, from: gateway, km: haversineKm(gateway.lat, gateway.lon, airport.lat, airport.lon), airlines: r.airlines });
    }
    out.sort((a, b) => a.km - b.km);
    return out;
  }, [gateway, routesFrom, byIata]);

  const shown = useMemo(() => {
    const b = BANDS.find((x) => x.key === band);
    return b ? destinations.filter((d) => b.test(flightMinutes(d.km))) : destinations;
  }, [destinations, band]);

  // The map itself: created once, spins slowly until the user touches it.
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapEl.current,
      style: STYLE,
      center: [20, 25],
      zoom: 1.5,
      maxPitch: 60,
      attributionControl: { compact: true },
    });
    map.on("style.load", () => {
      map.setProjection({ type: "globe" });
      map.setSky({ "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0] });
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new maplibregl.GlobeControl(), "bottom-right");

    const overlay = new MapLibreOverlay({ interleaved: false, layers: [], getTooltip: tooltip });
    map.addControl(overlay);

    const stop = () => {
      spinRef.current = false;
    };
    map.on("mousedown", stop);
    map.on("touchstart", stop);
    map.on("wheel", stop);

    let raf = 0;
    const spin = () => {
      if (spinRef.current) {
        const c = map.getCenter();
        map.setCenter([c.lng + 0.05, c.lat]);
      }
      raf = requestAnimationFrame(spin);
    };
    raf = requestAnimationFrame(spin);

    mapRef.current = map;
    overlayRef.current = overlay;
    return () => {
      cancelAnimationFrame(raf);
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // First reveal: once we know where the user is, stop spinning and fly there.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !origin) return;
    spinRef.current = false;
    map.flyTo({ center: [origin.lon, origin.lat], zoom: 3.2, duration: 2600, padding: PANEL_PADDING, essential: true });
  }, [origin]);

  function focusDestination(iata: string | null) {
    setSelectedDest(iata);
    const map = mapRef.current;
    const dest = iata ? byIata.get(iata) : null;
    if (!map || !dest || !gateway) return;
    const bounds = new maplibregl.LngLatBounds([gateway.lon, gateway.lat], [gateway.lon, gateway.lat]).extend([dest.lon, dest.lat]);
    map.fitBounds(bounds, { padding: PANEL_PADDING, maxZoom: 5, duration: 1400 });
  }

  function focusGateway(iata: string) {
    setGatewayIata(iata);
    setSelectedDest(null);
    const map = mapRef.current;
    const g = byIata.get(iata);
    if (map && g) map.flyTo({ center: [g.lon, g.lat], zoom: Math.max(map.getZoom(), 3), duration: 1200, padding: PANEL_PADDING });
  }

  // deck.gl layers follow the state. Globe needs back-face culling off or arcs disappear.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const layers: (Layer | null)[] = [
      new ScatterplotLayer<Airport>({
        id: "airports",
        data: airports,
        getPosition: (a) => [a.lon, a.lat],
        radiusUnits: "pixels",
        getRadius: (a) => (a.size === "large" ? 2.6 : a.size === "medium" ? 1.8 : 1.1),
        getFillColor: [150, 165, 190, 110],
      }),
      new ArcLayer<Destination>({
        id: "arcs",
        data: shown,
        getSourcePosition: (d) => [d.from.lon, d.from.lat],
        getTargetPosition: (d) => [d.airport.lon, d.airport.lat],
        getSourceColor: (d) => arcColor(flightMinutes(d.km)),
        getTargetColor: (d) => arcColor(flightMinutes(d.km)),
        getWidth: (d) => (d.airport.iata === selectedDest ? 4 : 1.5),
        greatCircle: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 230],
        parameters: { cullMode: "none" },
        updateTriggers: { getWidth: [selectedDest] },
        onClick: (info) => focusDestination((info.object as Destination | undefined)?.airport.iata ?? null),
      }),
      new ScatterplotLayer<Destination>({
        id: "destinations",
        data: shown,
        getPosition: (d) => [d.airport.lon, d.airport.lat],
        radiusUnits: "pixels",
        getRadius: (d) => (d.airport.iata === selectedDest ? 6 : 3.2),
        getFillColor: (d) => arcColor(flightMinutes(d.km)),
        pickable: true,
        updateTriggers: { getRadius: [selectedDest] },
        onClick: (info) => focusDestination((info.object as Destination | undefined)?.airport.iata ?? null),
      }),
      new ScatterplotLayer<Gateway>({
        id: "gateways",
        data: gateways,
        getPosition: (g) => [g.airport.lon, g.airport.lat],
        radiusUnits: "pixels",
        getRadius: (g) => (g.airport.iata === gatewayIata ? 7 : 4.5),
        getFillColor: (g) => (g.airport.iata === gatewayIata ? [255, 180, 84, 255] : [255, 180, 84, 150]),
        stroked: true,
        lineWidthUnits: "pixels",
        getLineWidth: 1,
        getLineColor: [255, 255, 255, 210],
        pickable: true,
        updateTriggers: { getRadius: [gatewayIata], getFillColor: [gatewayIata] },
        onClick: (info) => {
          const g = info.object as Gateway | undefined;
          if (g) focusGateway(g.airport.iata);
        },
      }),
      origin
        ? new ScatterplotLayer<Origin>({
            id: "origin",
            data: [origin],
            getPosition: (o) => [o.lon, o.lat],
            radiusUnits: "pixels",
            getRadius: 5,
            getFillColor: [76, 201, 240, 255],
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: 1.5,
            getLineColor: [255, 255, 255, 230],
            pickable: true,
          })
        : null,
    ];
    overlay.setProps({ layers: layers.filter(Boolean) as Layer[] });
    // focusDestination/focusGateway are stable enough: they only read refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [airports, shown, gateways, gatewayIata, origin, selectedDest]);

  return (
    <div className="app">
      <div ref={mapEl} className="map" />
      <div className="brand">
        <h1>Atlas</h1>
        <span>where can you go from here</span>
      </div>
      <Panel
        origin={origin}
        airports={airports}
        gateways={gateways}
        routeCounts={routeCounts}
        gatewayIata={gatewayIata}
        onGateway={focusGateway}
        band={band}
        onBand={setBand}
        destinations={shown}
        totalDestinations={destinations.length}
        selectedDest={selectedDest}
        onDest={focusDestination}
        onOrigin={(a) => {
          setSelectedDest(null);
          setOrigin({ lat: a.lat, lon: a.lon, label: a.city ?? a.name, source: "search" });
        }}
      />
      {manifest && (
        <div className="provenance" title="Every number on this globe says where it came from.">
          Airports: {manifest.airports?.source} · {manifest.airports?.licence} · {manifest.airports?.fetchedAt.slice(0, 10)}
          {" · "}Network: {manifest.routes?.source} · {manifest.routes?.note?.split(".")[0]}
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import { ArcLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Layer, PickingInfo } from "@deck.gl/core";
import { flightMinutes, formatDuration, haversineKm, nearestGateways } from "@/lib/geo";
import { combinePlaces, type Place } from "@/lib/places";
import type { Trip, TripCity, TripLeg, TripsResult } from "@/lib/trips";
import type { PlaceSummary } from "@/app/api/place/route";
import type {
  Airport,
  City,
  CityPlaces,
  CountryInfo,
  Deal,
  DealsFile,
  Destination,
  FaresResponse,
  Gateway,
  HeritageRow,
  Holiday,
  Manifest,
  ReachResponse,
  ReachStation,
  Route,
  VisaFile,
  WeatherCompact,
  WeatherFile,
} from "@/lib/types";
import { expandWeather, visaFor } from "@/lib/types";
import Panel, { BANDS, MODE_LABEL, dealKey, type Band, type DealNights, type Intel, type View } from "./Panel";

// The bundler cannot resolve MapLibre's worker from import.meta.url; see scripts/copy-worker.mjs.
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

const STYLE = "https://tiles.openfreemap.org/styles/dark";
// Layers of the OpenFreeMap dark style that compete with the arcs: regions, small places, minor roads, rail.
const CLUTTER = [
  "place_state", "place_suburb", "place_other", "place_village",
  "highway_minor", "highway_path", "highway_name_other", "highway_name_motorway",
  "road_oneway", "road_oneway_opposite",
  "railway", "railway_dashline", "railway_transit", "railway_transit_dashline", "railway_minor", "railway_minor_dashline",
  "building", "landuse_residential",
];
// Keep the interesting part of the globe clear of the panel: left of it on desktop, above the
// bottom sheet on phones (the sheet takes 52vh, see globals.css).
function panelPadding() {
  if (typeof window !== "undefined" && window.innerWidth <= 720) {
    return { left: 16, right: 16, top: 60, bottom: Math.round(window.innerHeight * 0.6) + 24 };
  }
  return { left: 430, top: 60, right: 60, bottom: 60 };
}

export type Origin = { lat: number; lon: number; label: string; source: "gps" | "ip" | "default" | "search" };
const DEFAULT_ORIGIN: Origin = { lat: 45.6579, lon: 25.6012, label: "Brașov", source: "default" };
export type LocationHint = { lat: number; lon: number; label: string };

type RGBA = [number, number, number, number];
export function arcColor(min: number): RGBA {
  if (min < 120) return [76, 201, 240, 200];
  if (min < 300) return [255, 180, 84, 200];
  return [255, 107, 107, 180];
}
export function priceColor(eur: number): RGBA {
  if (eur < 60) return [76, 201, 240, 230];
  if (eur < 150) return [255, 180, 84, 230];
  return [255, 107, 107, 210];
}
/** Routes known only from the 2014 network, once live fares are on screen. */
const DIM: RGBA = [140, 150, 170, 70];
/** Weekend high in °C → cold blue through warm amber to hot coral. */
export function tempColor(c: number): RGBA {
  if (c < 10) return [96, 140, 240, 220];
  if (c < 20) return [76, 201, 240, 220];
  if (c < 27) return [255, 180, 84, 230];
  return [255, 107, 107, 230];
}

const regionNames = typeof Intl !== "undefined" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;
export function countryName(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

const TOOLTIP_STYLE = {
  background: "rgba(10,14,24,0.92)",
  color: "#e9edf5",
  fontSize: "12px",
  lineHeight: "1.35",
  padding: "8px 10px",
  borderRadius: "10px",
  border: "1px solid rgba(255,255,255,0.08)",
  maxWidth: "260px",
};

function changesText(n: number | undefined): string {
  return n ? `${n} change${n === 1 ? "" : "s"}` : "direct";
}

type Picked = Place | Destination | Gateway | Origin | ReachStation | TripCity;
function isTripCity(o: Picked): o is TripCity {
  return "code" in o && "country" in o && !("key" in o) && !("airport" in o);
}

function tooltip(info: PickingInfo): null | { html: string; style: Record<string, string> } {
  const o = info.object as Picked | undefined;
  if (!o) return null;
  let html: string;
  if (isTripCity(o)) {
    html = `<b>${o.name}</b>, ${countryName(o.country)}`;
  } else if ("key" in o) {
    const where = [o.name, o.country ? countryName(o.country) : ""].filter(Boolean).join(", ");
    const alt =
      o.mode === "plane" && o.ground
        ? `<br/>or ${formatDuration(o.ground.minutes)} by ${o.ground.mode}`
        : o.mode !== "plane" && o.air
          ? `<br/>or ~${formatDuration(o.air.minutes)} flying via ${o.air.gateway.iata}`
          : "";
    html = `<b>${where}</b><br/>${MODE_LABEL[o.mode]} · ${formatDuration(o.minutes)}${o.mode === "plane" ? ` via ${o.air?.gateway.iata}` : ` · ${changesText(o.changes)}`}${o.price != null ? ` · <b>from €${o.price}</b>` : ""}${alt}`;
  } else if ("changes" in o) {
    html = `<b>${o.name}</b><br/>${formatDuration(o.minutes)} · ${changesText(o.changes)} · by ${o.mode}`;
  } else if ("from" in o) {
    const where = [o.airport.city, countryName(o.airport.country)].filter(Boolean).join(", ");
    const fare = o.fare
      ? `<b>from €${o.fare.price}</b> · ${o.fare.departureAt} · ${o.fare.transfers ? `${o.fare.transfers} stop` : "direct"}<br/>`
      : "";
    const network = o.airlines ? ` · ${o.airlines} airline${o.airlines === 1 ? "" : "s"} (2014 network)` : "";
    html = `<span class="code">${o.airport.iata}</span> ${where}<br/>${fare}~${formatDuration(flightMinutes(o.km))} flight · ${Math.round(o.km)} km${network}`;
  } else if ("driveMin" in o) {
    html = `<span class="code">${o.airport.iata}</span> ${o.airport.name}<br/>${formatDuration(o.driveMin)} drive · ${Math.round(o.km)} km`;
  } else {
    html = `You are here (${o.source})`;
  }
  return { html, style: TOOLTIP_STYLE };
}

export default function Globe({ hint }: { hint?: LocationHint | null }) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapLibreOverlay | null>(null);
  const spinRef = useRef(true);

  const [airports, setAirports] = useState<Airport[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [airlines, setAirlines] = useState<Record<string, string>>({});
  const [cities, setCities] = useState<Record<string, City>>({});
  const [countries, setCountries] = useState<Record<string, CountryInfo>>({});
  const [holidays, setHolidays] = useState<Record<string, Holiday[]>>({});
  const [weather, setWeather] = useState<WeatherFile | null>(null);
  const [cityPlaces, setCityPlaces] = useState<Record<string, CityPlaces>>({});
  const [heritage, setHeritage] = useState<HeritageRow[]>([]);
  const [visa, setVisa] = useState<VisaFile | null>(null);
  const [dealsFile, setDealsFile] = useState<DealsFile | null>(null);
  const [selectedDeal, setSelectedDeal] = useState<string | null>(null);
  const [dealNights, setDealNights] = useState<DealNights>("any");
  const [directOnly, setDirectOnly] = useState(false);
  const [dealGateway, setDealGateway] = useState<string>("all");
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [ask, setAsk] = useState<{ status: string; text: string; used: string[]; note?: string; question: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [askOnly, setAskOnly] = useState(true);
  const [events, setEvents] = useState<{ name: string; date: string; venue?: string; kind?: string; url: string }[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [summary, setSummary] = useState<PlaceSummary | null>(null);
  const [warmOnly, setWarmOnly] = useState(false);
  const [around, setAround] = useState<string | null>(null);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [gatewayIata, setGatewayIata] = useState<string | null>(null);
  const [band, setBand] = useState<Band>("all");
  const [selectedDest, setSelectedDest] = useState<string | null>(null);
  const [faresByGateway, setFaresByGateway] = useState<Record<string, FaresResponse>>({});
  const [pricedOnly, setPricedOnly] = useState(false);
  const [bigOnly, setBigOnly] = useState(true);
  const [view, setView] = useState<View>("deals");
  const [reach, setReach] = useState<ReachResponse | null>(null);
  const [selectedStation, setSelectedStation] = useState<number | null>(null);
  const [selectedPlace, setSelectedPlace] = useState<string | null>(null);
  const [trips, setTrips] = useState<TripsResult | null>(null);
  const [selectedTrip, setSelectedTrip] = useState<string | null>(null);
  const [days, setDays] = useState(5);

  // Static data, produced by scripts/ingest and committed under public/data. A file that an
  // ingest has not produced yet is simply absent, never a broken globe.
  useEffect(() => {
    const load = (f: string) =>
      fetch(`/data/${f}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    Promise.all([
      load("airports.json"),
      load("routes-openflights.json"),
      load("airlines.json"),
      load("cities.json"),
      load("manifest.json"),
      load("countries.json"),
      load("holidays.json"),
      load("weather.json"),
      load("city-places.json"),
      load("heritage.json"),
      load("visa.json"),
      load("deals.json"),
    ]).then(([a, r, al, c, m, co, h, w, cp, he, vi, de]) => {
      setAirports(a ?? []);
      setRoutes(r ?? []);
      setAirlines(al ?? {});
      setCities(c ?? {});
      setManifest(m);
      setCountries(co ?? {});
      setHolidays(h ?? {});
      setWeather(w && (w as WeatherCompact).syms ? expandWeather(w as WeatherCompact) : null);
      setCityPlaces(cp ?? {});
      setHeritage(he ?? []);
      setVisa(vi);
      setDealsFile(de);
      // No deals file yet (first run): open on Explore rather than an empty Deals tab.
      if (!de?.deals?.length) setView((v) => (v === "deals" ? "all" : v));
    });
  }, []);

  // The address bar follows the globe, so any view is a link: ?from=lat,lon,label&view=all&place=air:BUH
  useEffect(() => {
    if (!origin) return;
    const q = new URLSearchParams();
    q.set("from", `${origin.lat.toFixed(3)},${origin.lon.toFixed(3)},${origin.label}`);
    if (view !== "deals") q.set("view", view);
    if (view === "trips" && days !== 5) q.set("days", String(days));
    if (selectedPlace && view !== "deals") q.set("place", selectedPlace);
    if (selectedDeal && view === "deals") q.set("deal", selectedDeal);
    const url = `${window.location.pathname}?${q.toString()}`;
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", url);
  }, [origin, view, days, selectedPlace, selectedDeal]);

  // Airport → city code, so one city with several airports is one place.
  const cityOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const [code, c] of Object.entries(cities)) for (const iata of c.airports) m.set(iata, code);
    return m;
  }, [cities]);

  // Which city a place belongs to: its own for air places, the nearest city centre within 50 km
  // for a station. Memoised per place key.
  const cityCodeCache = useRef(new Map<string, string | null>());
  const cityCodeFor = (p: Place): string | null => {
    if (p.air) return p.key.slice(4);
    const hit = cityCodeCache.current.get(p.key);
    if (hit !== undefined) return hit;
    let best: string | null = null;
    let bestKm = 50;
    for (const [code, c] of Object.entries(cities)) {
      const km = haversineKm(p.lat, p.lon, c.lat, c.lon);
      if (km < bestKm) {
        bestKm = km;
        best = code;
      }
    }
    cityCodeCache.current.set(p.key, best);
    return best;
  };

  // Next Saturday and Sunday, as the forecast files date them.
  const weekend = useMemo(() => {
    const d = new Date();
    const toSat = (6 - d.getDay() + 7) % 7;
    const sat = new Date(d.getTime() + toSat * 86_400_000);
    const sun = new Date(sat.getTime() + 86_400_000);
    return [sat.toISOString().slice(0, 10), sun.toISOString().slice(0, 10)];
  }, []);
  const weekendMax = (code: string | null): number | null => {
    const days = code ? weather?.cities[code] : undefined;
    if (!days) return null;
    const t = days.filter((x) => weekend.includes(x.d)).map((x) => x.tmax);
    return t.length ? Math.max(...t) : null;
  };

  // Where the user is: a shared link wins, then the network hint at once, the browser's
  // position when allowed, a fixed city when nothing else, so the globe always has a story.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const from = q.get("from")?.split(",");
    if (from && from.length >= 2 && Number.isFinite(Number(from[0])) && Number.isFinite(Number(from[1]))) {
      setOrigin({ lat: Number(from[0]), lon: Number(from[1]), label: from.slice(2).join(",") || "shared location", source: "search" });
      const v = q.get("view");
      if (v === "deals" || v === "all" || v === "fly" || v === "ground" || v === "trips") setView(v);
      const d = Number(q.get("days"));
      if ([3, 5, 7, 10].includes(d)) setDays(d);
      const place = q.get("place");
      if (place) setSelectedPlace(place);
      const deal = q.get("deal");
      if (deal) setSelectedDeal(deal);
      return;
    }
    const v = new URLSearchParams(window.location.search).get("view");
    if (v === "deals" || v === "all" || v === "fly" || v === "ground" || v === "trips") setView(v);
    const fallback: Origin = hint ? { ...hint, source: "ip" } : DEFAULT_ORIGIN;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setOrigin(fallback);
      return;
    }
    if (hint) setOrigin(fallback);
    navigator.geolocation.getCurrentPosition(
      (p) => setOrigin({ lat: p.coords.latitude, lon: p.coords.longitude, label: "your location", source: "gps" }),
      () => setOrigin((o) => o ?? fallback),
      { timeout: 8000, maximumAge: 600_000 },
    );
    // The hint comes from the server render and never changes afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Cached fares for every gateway (server route; empty until the token is set).
  useEffect(() => {
    if (!gateways.length) return;
    const ctrl = new AbortController();
    setFaresByGateway({});
    Promise.all(
      gateways.map((g) =>
        fetch(`/api/fares?origin=${g.airport.iata}`, { signal: ctrl.signal })
          .then((r) => r.json())
          .then((j: FaresResponse) => [g.airport.iata, j] as const)
          .catch(() => null),
      ),
    ).then((results) => {
      if (ctrl.signal.aborted) return;
      const map: Record<string, FaresResponse> = {};
      for (const r of results) if (r) map[r[0]] = r[1];
      setFaresByGateway(map);
    });
    return () => ctrl.abort();
  }, [gateways]);

  const fares = gatewayIata ? (faresByGateway[gatewayIata] ?? null) : null;
  const live = fares?.status === "ok" && fares.origin === gateway?.iata;

  // Destinations = the 2014 network ∪ every airport with a live fare. Priced ones sort first, by price.
  const destinations = useMemo<Destination[]>(() => {
    if (!gateway) return [];
    const fareByDst = new Map(live ? fares!.fares.map((f) => [f.dst, f] as const) : []);
    const seen = new Map<string, Destination>();
    const add = (iata: string, airlines: number) => {
      const airport = byIata.get(iata);
      if (!airport || seen.has(iata)) return;
      const km = haversineKm(gateway.lat, gateway.lon, airport.lat, airport.lon);
      seen.set(iata, { airport, from: gateway, km, airlines, fare: fareByDst.get(iata) });
    };
    for (const r of routesFrom.get(gateway.iata) ?? []) add(r.dst, r.airlines);
    for (const dst of fareByDst.keys()) add(dst, 0);
    const out = [...seen.values()];
    out.sort((a, b) => {
      if (a.fare && b.fare) return a.fare.price - b.fare.price;
      if (a.fare || b.fare) return a.fare ? -1 : 1;
      return a.km - b.km;
    });
    return out;
  }, [gateway, routesFrom, byIata, fares, live]);

  const shown = useMemo(() => {
    const b = BANDS.find((x) => x.key === band);
    return destinations.filter((d) => (!b || b.test(flightMinutes(d.km))) && (!pricedOnly || d.fare));
  }, [destinations, band, pricedOnly]);

  // Ground: everything reachable by train and coach from where the user is (needed by "all" and "ground").
  const wantReach = view !== "fly";
  useEffect(() => {
    if (!wantReach || !origin) return;
    const ctrl = new AbortController();
    setReach(null);
    setSelectedStation(null);
    fetch(`/api/reach?lat=${origin.lat.toFixed(3)}&lon=${origin.lon.toFixed(3)}&max=600`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((j: ReachResponse) => setReach(j))
      .catch(() => {});
    return () => ctrl.abort();
  }, [wantReach, origin]);

  const reachBand = useMemo(() => {
    const b = BANDS.find((x) => x.key === band);
    return reach ? reach.reached.filter((s) => !b || b.test(s.minutes)) : [];
  }, [reach, band]);

  // One row per place name in the list; the fastest station wins.
  const reachShown = useMemo(() => {
    const seen = new Set<string>();
    return reachBand.filter((s) => !seen.has(s.name) && seen.add(s.name));
  }, [reachBand]);

  // Combined: the best way to every place.
  const places = useMemo<Place[]>(
    () =>
      view === "all" && origin
        ? combinePlaces({ origin, gateways, routesFrom, byIata, cities, cityOf, faresByGateway, reach })
        : [],
    [view, origin, gateways, routesFrom, byIata, cities, cityOf, faresByGateway, reach],
  );
  // "Big places": any city with an airport, or a station that is a junction or busy (lib/places.ts).
  // "Warm this weekend": at least 20 °C on Saturday or Sunday in the nearest forecast city.
  const placesShown = useMemo(() => {
    const b = BANDS.find((x) => x.key === band);
    return places.filter(
      (p) =>
        (!b || b.test(p.minutes)) &&
        (!pricedOnly || p.price != null) &&
        (!bigOnly || p.air || p.importance >= 0.33) &&
        (!warmOnly || (weekendMax(cityCodeFor(p)) ?? -99) >= 20),
    );
    // cityCodeFor/weekendMax read cities and weather, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, band, pricedOnly, bigOnly, warmOnly, cities, weather]);

  // Deals: cheapest return getaways from the home gateways (nightly file), one card per city.
  const dealsAll = dealsFile?.deals ?? [];
  const dealsShown = useMemo<Deal[]>(() => {
    const range: Record<DealNights, [number, number]> = { any: [0, 99], "2-3": [2, 3], "4-5": [4, 5], "6-7": [6, 7] };
    const [lo, hi] = range[dealNights];
    const seen = new Set<string>();
    const out: Deal[] = [];
    for (const d of dealsAll) {
      if (d.nights < lo || d.nights > hi) continue;
      if (directOnly && d.stops > 0) continue;
      if (dealGateway !== "all" && d.gw !== dealGateway) continue;
      if (warmOnly && (weekendMax(d.dstCity) ?? -99) < 20) continue;
      if (seen.has(d.dstCity)) continue;
      seen.add(d.dstCity);
      out.push(d);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealsAll, dealNights, directOnly, dealGateway, warmOnly, weather]);
  // After a question, the cards narrow to the deals the agent used, until "Show all".
  const dealsList = useMemo<Deal[]>(() => {
    if (!askOnly || !ask?.used.length) return dealsShown;
    const used = new Set(ask.used);
    return dealsAll.filter((d) => used.has(dealKey(d))).sort((a, b) => a.price - b.price);
  }, [dealsShown, dealsAll, ask, askOnly]);
  const deal = selectedDeal ? (dealsAll.find((d) => dealKey(d) === selectedDeal) ?? null) : null;

  async function askAgent(question: string) {
    setAsking(true);
    setSelectedDeal(null);
    setAskOnly(true);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, home: gateways[0]?.airport.country ?? "RO" }),
      });
      const j = (await r.json()) as { status: string; text: string; used: string[]; note?: string };
      setAsk({ ...j, used: j.used ?? [], question });
    } catch {
      setAsk({ status: "error", text: "", used: [], note: "The agent did not answer.", question });
    } finally {
      setAsking(false);
    }
  }
  const dealOptions = useMemo(
    () => (deal ? dealsAll.filter((d) => d.dstCity === deal.dstCity).sort((a, b) => a.price - b.price).slice(0, 6) : []),
    [deal, dealsAll],
  );
  const dealCoord = (d: Deal): [number, number] | null => {
    const c = cities[d.dstCity] ?? cities[d.dst];
    if (c) return [c.lon, c.lat];
    const a = byIata.get(d.dst);
    return a ? [a.lon, a.lat] : null;
  };

  // A short reason to go, from what we already know about the city.
  const whyOf = (code: string, lat: number, lon: number): string => {
    const p = cityPlaces[code];
    const bits: string[] = [];
    const near = heritage.filter((h) => haversineKm(lat, lon, h[1], h[2]) <= 40).length;
    if (near) bits.push(near === 1 ? "World Heritage site" : `${near} World Heritage sites`);
    if (p?.food && p.food >= 1000) bits.push(`${(p.food / 1000).toFixed(1)}k restaurants`);
    if (p?.night && p.night >= 100) bits.push(`${p.night} nightlife spots`);
    if (p?.nature && p.nature >= 150) bits.push("parks and nature");
    if (p?.culture && p.culture >= 300 && !near) bits.push(`${(p.culture / 1000).toFixed(1).replace(".0", "")}k cultural sights`);
    return bits.slice(0, 2).join(" · ");
  };

  // Photos for the deal cards: Wikivoyage thumbnails, fetched lazily and kept.
  useEffect(() => {
    if (view !== "deals") return;
    const missing = dealsShown.slice(0, 40).map((d) => d.city).filter((name, i, arr) => !(name in thumbs) && arr.indexOf(name) === i);
    if (!missing.length) return;
    const ctrl = new AbortController();
    (async () => {
      const found: Record<string, string> = {};
      for (let i = 0; i < missing.length; i += 6) {
        await Promise.all(
          missing.slice(i, i + 6).map(async (name) => {
            try {
              const r = await fetch(`/api/place?name=${encodeURIComponent(name)}`, { signal: ctrl.signal });
              const j = r.ok ? ((await r.json()) as PlaceSummary | null) : null;
              found[name] = j?.thumbnail ?? "";
            } catch {
              found[name] = "";
            }
          }),
        );
        if (ctrl.signal.aborted) return;
        setThumbs((t) => ({ ...t, ...found }));
      }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, dealsShown]);

  // Everything we know about the selected city and country: a place in Explore, a deal in Deals.
  const selected = selectedPlace ? places.find((x) => x.key === selectedPlace) : null;
  const target = useMemo(() => {
    if (view === "deals" && deal) {
      const c = cities[deal.dstCity];
      const coord = dealCoord(deal);
      return coord ? { code: deal.dstCity, name: deal.city, lat: coord[1], lon: coord[0], country: deal.country || c?.country, pop: c?.pop } : null;
    }
    if (selected) {
      const code = cityCodeFor(selected);
      return { code: code ?? undefined, name: code ? (cities[code]?.name ?? selected.name) : selected.name, lat: selected.lat, lon: selected.lon, country: selected.country ?? (code ? cities[code]?.country : undefined), pop: (code ? cities[code]?.pop : undefined) ?? selected.ground?.pop };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, deal, selected, cities]);

  const intel = useMemo<Intel | null>(() => {
    if (!target) return null;
    const code = target.code;
    const city = code ? cities[code] : undefined;
    const countryCode = target.country;
    const horizon = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    return {
      code,
      tz: city?.tz,
      lat: target.lat,
      lon: target.lon,
      countryCode,
      country: countryCode ? countries[countryCode] : undefined,
      weather: code ? weather?.cities[code] : undefined,
      sea: code ? weather?.sea[code] : undefined,
      holidays: countryCode ? (holidays[countryCode] ?? []).filter((h) => h.date >= today && h.date <= horizon).slice(0, 2) : undefined,
      places: code ? cityPlaces[code] : undefined,
      pop: target.pop ?? undefined,
      visa:
        visa && countryCode && gateways[0] && gateways[0].airport.country !== countryCode
          ? { passport: gateways[0].airport.country, text: visaFor(visa, gateways[0].airport.country, countryCode), updated: visa.updated }
          : undefined,
      heritage: heritage
        .map((h) => ({ name: h[0], km: Math.round(haversineKm(target.lat, target.lon, h[1], h[2])) }))
        .filter((h) => h.km <= 60)
        .sort((a, b) => a.km - b.km)
        .slice(0, 3),
      events,
    };
  }, [target, cities, countries, weather, holidays, cityPlaces, heritage, visa, gateways, events]);

  // Events near the selected city (Ticketmaster, when the key exists; silent otherwise).
  useEffect(() => {
    setEvents([]);
    if (!target) return;
    const ctrl = new AbortController();
    fetch(`/api/events?lat=${target.lat.toFixed(3)}&lon=${target.lon.toFixed(3)}&days=30`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { status: string; events?: typeof events } | null) => setEvents(j?.status === "ok" ? (j.events ?? []) : []))
      .catch(() => {});
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.code, target?.lat, target?.lon]);

  // One paragraph from Wikivoyage for the selected city, by name.
  useEffect(() => {
    setSummary(null);
    const name = target?.name;
    if (!name) return;
    const ctrl = new AbortController();
    fetch(`/api/place?name=${encodeURIComponent(name)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: PlaceSummary | null) => setSummary(j))
      .catch(() => {});
    return () => ctrl.abort();
  }, [target?.name]);

  // Your own long weekends: holidays at home in the next 120 days, as trip-date suggestions.
  const homeHolidays = useMemo(() => {
    const home = gateways[0]?.airport.country;
    if (!home) return [];
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
    return (holidays[home] ?? []).filter((h) => h.national && h.date >= today && h.date <= horizon).slice(0, 5);
  }, [gateways, holidays]);
  const anyFares = Object.values(faresByGateway).some((f) => f.status === "ok" && f.fares.length > 0);

  // Trips: open-jaw loops from the gateways, searched on the server.
  useEffect(() => {
    if (view !== "trips" || !gateways.length) return;
    const ctrl = new AbortController();
    setTrips(null);
    setSelectedTrip(null);
    const g = gateways.map((x) => `${x.airport.iata}:${x.airport.lat}:${x.airport.lon}:${x.driveMin}`).join(",");
    const extra = around ? `&around=${around}` : "";
    fetch(`/api/trips?g=${g}&home=${gateways[0].airport.country}&days=${days}${extra}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((j: TripsResult) => {
        setTrips(j);
        if (j.trips?.[0]) setSelectedTrip(j.trips[0].id);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [view, gateways, days, around]);

  const trip: Trip | null = view === "trips" && trips ? (trips.trips.find((t) => t.id === selectedTrip) ?? null) : null;

  const pathForSelected = useMemo<[number, number][]>(() => {
    if (!reach || selectedStation == null) return [];
    const byId = new Map<number, { lat: number; lon: number; prev: number }>();
    for (const s of reach.reached) byId.set(s.id, s);
    for (const s of reach.starts) byId.set(s.id, { lat: s.lat, lon: s.lon, prev: -1 });
    const pts: [number, number][] = [];
    let cur = selectedStation;
    for (let guard = 0; cur >= 0 && guard < 500; guard++) {
      const s = byId.get(cur);
      if (!s) break;
      pts.push([s.lon, s.lat]);
      cur = s.prev;
    }
    if (origin) pts.push([origin.lon, origin.lat]);
    return pts.reverse();
  }, [reach, selectedStation, origin]);

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
      for (const id of CLUTTER) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
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
    map.flyTo({ center: [origin.lon, origin.lat], zoom: 3.2, duration: 2600, padding: panelPadding(), essential: true });
  }, [origin]);

  function fitTo(lat: number, lon: number, maxZoom: number) {
    const map = mapRef.current;
    if (!map || !origin) return;
    const bounds = new maplibregl.LngLatBounds([origin.lon, origin.lat], [origin.lon, origin.lat]).extend([lon, lat]);
    map.fitBounds(bounds, { padding: panelPadding(), maxZoom, duration: 1300 });
  }

  function focusDestination(iata: string | null) {
    setSelectedDest(iata);
    const dest = iata ? byIata.get(iata) : null;
    if (dest && gateway) {
      const map = mapRef.current;
      if (!map) return;
      const bounds = new maplibregl.LngLatBounds([gateway.lon, gateway.lat], [gateway.lon, gateway.lat]).extend([dest.lon, dest.lat]);
      map.fitBounds(bounds, { padding: panelPadding(), maxZoom: 5, duration: 1400 });
    }
  }

  function focusStation(id: number | null) {
    setSelectedStation(id);
    const s = id != null ? reach?.reached.find((r) => r.id === id) : null;
    if (s) fitTo(s.lat, s.lon, 7);
  }

  function focusPlace(key: string | null) {
    setSelectedPlace(key);
    const p = key ? places.find((x) => x.key === key) : null;
    setSelectedStation(p?.ground && p.mode !== "plane" ? p.ground.id : null);
    if (p) fitTo(p.lat, p.lon, p.mode === "plane" ? 5 : 7);
  }

  function focusTrip(id: string | null) {
    setSelectedTrip(id);
    const t = id ? trips?.trips.find((x) => x.id === id) : null;
    const map = mapRef.current;
    if (!map || !t || !origin) return;
    const bounds = new maplibregl.LngLatBounds([origin.lon, origin.lat], [origin.lon, origin.lat]);
    for (const c of t.cities) bounds.extend([c.lon, c.lat]);
    map.fitBounds(bounds, { padding: panelPadding(), maxZoom: 6, duration: 1400 });
  }

  function focusDeal(key: string | null) {
    setSelectedDeal(key);
    const d = key ? dealsAll.find((x) => dealKey(x) === key) : null;
    const map = mapRef.current;
    const g = d ? byIata.get(d.gw) : null;
    const c = d ? dealCoord(d) : null;
    if (!map || !d || !g || !c) return;
    const bounds = new maplibregl.LngLatBounds([g.lon, g.lat], [g.lon, g.lat]).extend(c);
    map.fitBounds(bounds, { padding: panelPadding(), maxZoom: 5, duration: 1300 });
  }

  function focusGateway(iata: string) {
    setGatewayIata(iata);
    setSelectedDest(null);
    const map = mapRef.current;
    const g = byIata.get(iata);
    if (map && g) map.flyTo({ center: [g.lon, g.lat], zoom: Math.max(map.getZoom(), 3), duration: 1200, padding: panelPadding() });
  }

  // deck.gl layers follow the state. Globe needs back-face culling off or arcs disappear.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    // With live fares on screen, colour means price; routes only the 2014 network knows go dim.
    const colorOf = (d: Destination): RGBA => (live ? (d.fare ? priceColor(d.fare.price) : DIM) : arcColor(flightMinutes(d.km)));
    const ground = view === "ground";
    const all = view === "all";
    const fly = view === "fly";
    const tripView = view === "trips";
    const dealView = view === "deals";
    // Explore draws arcs only for the selected place; the lines were the thing nobody understood.
    const flownPlaces = placesShown.filter((p) => p.mode === "plane" && p.air && p.key === selectedPlace);
    const dealArcs = dealView
      ? dealsList
          .slice(0, 16)
          .concat(deal && !dealsList.slice(0, 16).some((d) => dealKey(d) === selectedDeal) ? [deal] : [])
          .map((d) => ({ d, s: byIata.get(d.gw), t: dealCoord(d) }))
          .filter((x): x is { d: Deal; s: Airport; t: [number, number] } => !!x.s && !!x.t)
      : [];
    const dealDots = dealView ? dealsList.map((d) => ({ d, t: dealCoord(d) })).filter((x): x is { d: Deal; t: [number, number] } => !!x.t) : [];
    // A trip's legs resolve codes to coordinates: gateways by IATA, cities from the trip itself.
    const coordOf = (code: string): [number, number] | null => {
      const g = gateways.find((x) => x.airport.iata === code);
      if (g) return [g.airport.lon, g.airport.lat];
      const c = trip?.cities.find((x) => x.code === code);
      return c ? [c.lon, c.lat] : null;
    };
    const flyLegs = (trip?.legs ?? [])
      .filter((l): l is Extract<TripLeg, { kind: "fly" }> => l.kind === "fly")
      .map((l) => ({ s: coordOf(l.from), t: coordOf(l.to), leg: l }))
      .filter((x): x is { s: [number, number]; t: [number, number]; leg: Extract<TripLeg, { kind: "fly" }> } => !!x.s && !!x.t);
    const groundLegs = (trip?.legs ?? []).filter((l): l is Extract<TripLeg, { kind: "ground" }> => l.kind === "ground");
    const tripCities = new Map<string, TripCity>();
    for (const t of trips?.trips ?? []) for (const c of t.cities) tripCities.set(c.code, c);
    const layers: (Layer | null)[] = [
      dealView
        ? new ArcLayer<(typeof dealArcs)[number]>({
            id: "deal-arcs",
            data: dealArcs,
            getSourcePosition: (x) => [x.s.lon, x.s.lat],
            getTargetPosition: (x) => x.t,
            getSourceColor: (x) => (dealKey(x.d) === selectedDeal ? [255, 255, 255, 240] : priceColor(x.d.price)),
            getTargetColor: (x) => (dealKey(x.d) === selectedDeal ? [255, 255, 255, 240] : priceColor(x.d.price)),
            getWidth: (x) => (dealKey(x.d) === selectedDeal ? 4 : 1.4),
            greatCircle: true,
            pickable: true,
            autoHighlight: true,
            highlightColor: [255, 255, 255, 230],
            parameters: { cullMode: "none" },
            updateTriggers: { getWidth: [selectedDeal], getSourceColor: [selectedDeal], getTargetColor: [selectedDeal] },
            onClick: (info) => focusDeal(info.object ? dealKey((info.object as (typeof dealArcs)[number]).d) : null),
          })
        : null,
      dealView
        ? new ScatterplotLayer<(typeof dealDots)[number]>({
            id: "deal-dots",
            data: dealDots,
            getPosition: (x) => x.t,
            radiusUnits: "pixels",
            getRadius: (x) => (dealKey(x.d) === selectedDeal ? 8 : x.d.price < 60 ? 6 : x.d.price < 150 ? 4.5 : 3.5),
            getFillColor: (x) => priceColor(x.d.price),
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: 1,
            getLineColor: [255, 255, 255, 160],
            pickable: true,
            updateTriggers: { getRadius: [selectedDeal] },
            onClick: (info) => focusDeal(info.object ? dealKey((info.object as (typeof dealDots)[number]).d) : null),
          })
        : null,
      tripView
        ? new ScatterplotLayer<TripCity>({
            id: "trip-all-cities",
            data: [...tripCities.values()],
            getPosition: (c) => [c.lon, c.lat],
            radiusUnits: "pixels",
            getRadius: 3,
            getFillColor: [150, 165, 190, 140],
            pickable: true,
          })
        : null,
      tripView && trip
        ? new ArcLayer<(typeof flyLegs)[number]>({
            id: "trip-arcs",
            data: flyLegs,
            getSourcePosition: (x) => x.s,
            getTargetPosition: (x) => x.t,
            getSourceColor: [255, 180, 84, 230],
            getTargetColor: [255, 180, 84, 230],
            getWidth: 3,
            greatCircle: true,
            parameters: { cullMode: "none" },
          })
        : null,
      tripView && trip
        ? new PathLayer<Extract<TripLeg, { kind: "ground" }>>({
            id: "trip-paths",
            data: groundLegs,
            getPath: (l) => l.path,
            getColor: [76, 201, 240, 240],
            getWidth: 4,
            widthUnits: "pixels",
            parameters: { cullMode: "none" },
          })
        : null,
      tripView && trip
        ? new ScatterplotLayer<TripCity>({
            id: "trip-cities",
            data: trip.cities,
            getPosition: (c) => [c.lon, c.lat],
            radiusUnits: "pixels",
            getRadius: 7,
            getFillColor: [255, 255, 255, 240],
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: 2,
            getLineColor: [255, 180, 84, 255],
            pickable: true,
          })
        : null,
      new ScatterplotLayer<Airport>({
        id: "airports",
        data: airports,
        getPosition: (a) => [a.lon, a.lat],
        radiusUnits: "pixels",
        getRadius: (a) => (a.size === "large" ? 2.6 : a.size === "medium" ? 1.8 : 1.1),
        getFillColor: fly ? [150, 165, 190, 110] : [150, 165, 190, 50],
        updateTriggers: { getFillColor: [fly] },
      }),
      ground
        ? new ScatterplotLayer<ReachStation>({
            id: "reach",
            data: reachBand,
            getPosition: (s) => [s.lon, s.lat],
            radiusUnits: "pixels",
            getRadius: (s) => (s.id === selectedStation ? 6 : 2.8),
            getFillColor: (s) => arcColor(s.minutes),
            pickable: true,
            updateTriggers: { getRadius: [selectedStation] },
            onClick: (info) => focusStation((info.object as ReachStation | undefined)?.id ?? null),
          })
        : null,
      all
        ? new ArcLayer<Place>({
            id: "place-arcs",
            data: flownPlaces,
            getSourcePosition: (p) => [p.air!.gateway.lon, p.air!.gateway.lat],
            getTargetPosition: (p) => [p.lon, p.lat],
            getSourceColor: (p) => (p.price != null ? priceColor(p.price) : arcColor(p.minutes)),
            getTargetColor: (p) => (p.price != null ? priceColor(p.price) : arcColor(p.minutes)),
            getWidth: (p) => (p.key === selectedPlace ? 4 : p.price != null ? 1.8 : 1.1),
            greatCircle: true,
            pickable: true,
            autoHighlight: true,
            highlightColor: [255, 255, 255, 230],
            parameters: { cullMode: "none" },
            updateTriggers: { getWidth: [selectedPlace] },
            onClick: (info) => focusPlace((info.object as Place | undefined)?.key ?? null),
          })
        : null,
      all
        ? new ScatterplotLayer<Place>({
            id: "places",
            data: placesShown,
            getPosition: (p) => [p.lon, p.lat],
            radiusUnits: "pixels",
            getRadius: (p) => (p.key === selectedPlace ? 7 : p.air ? 4 : 2.2 + p.importance * 2),
            getFillColor: (p) => {
              if (!warmOnly) return arcColor(p.minutes);
              const t = weekendMax(cityCodeFor(p));
              return t == null ? DIM : tempColor(t);
            },
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: (p) => (p.mode === "plane" ? 0 : 1),
            getLineColor: [255, 255, 255, 140],
            pickable: true,
            updateTriggers: { getRadius: [selectedPlace], getFillColor: [warmOnly, weather] },
            onClick: (info) => focusPlace((info.object as Place | undefined)?.key ?? null),
          })
        : null,
      !fly && pathForSelected.length > 1
        ? new PathLayer<{ path: [number, number][] }>({
            id: "reach-path",
            data: [{ path: pathForSelected }],
            getPath: (d) => d.path,
            getColor: [255, 255, 255, 230],
            getWidth: 3,
            widthUnits: "pixels",
            parameters: { cullMode: "none" },
          })
        : null,
      fly
        ? new ArcLayer<Destination>({
            id: "arcs",
            data: shown,
            getSourcePosition: (d) => [d.from.lon, d.from.lat],
            getTargetPosition: (d) => [d.airport.lon, d.airport.lat],
            getSourceColor: colorOf,
            getTargetColor: colorOf,
            getWidth: (d) => (d.airport.iata === selectedDest ? 4 : d.fare ? 2 : 1.3),
            greatCircle: true,
            pickable: true,
            autoHighlight: true,
            highlightColor: [255, 255, 255, 230],
            parameters: { cullMode: "none" },
            updateTriggers: { getWidth: [selectedDest], getSourceColor: [live], getTargetColor: [live] },
            onClick: (info) => focusDestination((info.object as Destination | undefined)?.airport.iata ?? null),
          })
        : null,
      fly
        ? new ScatterplotLayer<Destination>({
            id: "destinations",
            data: shown,
            getPosition: (d) => [d.airport.lon, d.airport.lat],
            radiusUnits: "pixels",
            getRadius: (d) => (d.airport.iata === selectedDest ? 6 : d.fare ? 3.6 : 2.6),
            getFillColor: colorOf,
            pickable: true,
            updateTriggers: { getRadius: [selectedDest], getFillColor: [live] },
            onClick: (info) => focusDestination((info.object as Destination | undefined)?.airport.iata ?? null),
          })
        : null,
      ground || tripView || dealView
        ? null
        : new ScatterplotLayer<Gateway>({
            id: "gateways",
            data: gateways,
            getPosition: (g) => [g.airport.lon, g.airport.lat],
            radiusUnits: "pixels",
            getRadius: (g) => (fly && g.airport.iata === gatewayIata ? 7 : 4.5),
            getFillColor: (g) => (fly && g.airport.iata !== gatewayIata ? [255, 180, 84, 150] : [255, 180, 84, 255]),
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: 1,
            getLineColor: [255, 255, 255, 210],
            pickable: true,
            updateTriggers: { getRadius: [gatewayIata, fly], getFillColor: [gatewayIata, fly] },
            onClick: (info) => {
              const g = info.object as Gateway | undefined;
              if (g && fly) focusGateway(g.airport.iata);
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
    // focus* helpers only read refs and state setters; listing them would re-run this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [airports, shown, gateways, gatewayIata, origin, selectedDest, live, view, reachBand, selectedStation, pathForSelected, placesShown, selectedPlace, trips, trip, warmOnly, weather, dealsList, selectedDeal, deal]);

  const groundFeeds = reach ? reach.feeds.map((f) => f.attribution.split(" via ")[0].split(" (")[0]).join(", ") : "";

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
          setSelectedPlace(null);
          setOrigin({ lat: a.lat, lon: a.lon, label: a.city ?? a.name, source: "search" });
        }}
        fares={fares}
        anyFares={anyFares}
        airlines={airlines}
        pricedOnly={pricedOnly}
        onPricedOnly={setPricedOnly}
        bigOnly={bigOnly}
        onBigOnly={setBigOnly}
        view={view}
        onView={(v) => {
          setView(v);
          setSelectedDest(null);
          setSelectedStation(null);
          setSelectedPlace(null);
          setSelectedTrip(null);
          setSelectedDeal(null);
        }}
        dealsFile={dealsFile}
        deals={dealsList}
        deal={deal}
        ask={ask}
        asking={asking}
        onAsk={askAgent}
        askOnly={askOnly}
        onAskOnly={setAskOnly}
        dealOptions={dealOptions}
        onDeal={focusDeal}
        dealNights={dealNights}
        onDealNights={setDealNights}
        directOnly={directOnly}
        onDirectOnly={setDirectOnly}
        dealGateway={dealGateway}
        onDealGateway={setDealGateway}
        thumbs={thumbs}
        whyOf={(d) => {
          const c = dealCoord(d);
          return c ? whyOf(d.dstCity, c[1], c[0]) : "";
        }}
        reach={reach}
        reachShown={reachShown}
        selectedStation={selectedStation}
        onStation={focusStation}
        places={placesShown}
        totalPlaces={places.length}
        selectedPlace={selectedPlace}
        onPlace={focusPlace}
        trips={trips}
        selectedTrip={selectedTrip}
        onTrip={focusTrip}
        days={days}
        onDays={setDays}
        intel={intel}
        summary={summary}
        weatherReady={!!weather}
        warmOnly={warmOnly}
        onWarmOnly={setWarmOnly}
        homeHolidays={homeHolidays}
        around={around}
        onAround={setAround}
      />
      {manifest && (
        <div
          className="provenance"
          title={Object.values(manifest)
            .map((e) => `${e.source} (${e.licence}, ${e.fetchedAt.slice(0, 10)})`)
            .join("\n")}
        >
          Airports: {manifest.airports?.source} · {manifest.airports?.licence} · {manifest.airports?.fetchedAt.slice(0, 10)}
          {" · "}Network: {manifest.routes?.source} · {manifest.routes?.note?.split(".")[0]}
          {anyFares ? " · Fares: Aviasales cache via Travelpayouts · EUR" : ""}
          {wantReach && reach ? ` · Ground: ${reach.feeds.length} GTFS feeds (${groundFeeds}) · expected times, not a timetable` : ""}
          {weather ? ` · Weather: MET Norway (CC BY 4.0) ${weather.updated.slice(0, 10)}` : ""}
          {` · ${Object.keys(manifest).length} sources, hover for all`}
        </div>
      )}
    </div>
  );
}

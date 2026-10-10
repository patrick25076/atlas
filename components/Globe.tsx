"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import { ArcLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import type { Layer, PickingInfo } from "@deck.gl/core";
import { flightMinutes, formatDuration, haversineKm, nearestGateways } from "@/lib/geo";
import { combinePlaces, type Place } from "@/lib/places";
import type { Trip, TripCity, TripLeg, TripsResult } from "@/lib/trips";
import type { PlaceSummary } from "@/app/api/place/route";
import { fetchBoard } from "@/lib/boards-client";
import { greatCircle } from "@/lib/arc";
import { isGem, type FameFile } from "@/lib/gems";
import { countryName, dateRange } from "@/lib/format";
import { BANDS, dealKey, type AskState, type Band, type BoardState, type DealNights, type LiveSearch, type Origin, type Sheet, type View } from "@/lib/ui-types";
import type { Airport, City, CityPlaces, CountryInfo, Deal, Destination, FaresResponse, Gateway, HeritageRow, Holiday, Manifest, ReachResponse, ReachStation, Route, VisaFile, WeatherCompact, WeatherFile } from "@/lib/types";
import { expandWeather, visaFor } from "@/lib/types";
import Panel, { MODE_LABEL, type CombosState, type PlanState, type WildState } from "./Panel";
import type { Plan } from "@/lib/plan";
import type { EatsResponse } from "@/app/api/eats/route";
import type { HotelsResult } from "@/lib/liteapi";
import type { WildLeg, WildTrip } from "@/lib/wild";
import type { Sights, Sight } from "@/app/api/sights/route";
import TopBar from "./TopBar";
import PriceLabels, { type LabelItem } from "./PriceLabels";
import type { Intel } from "./PlaceIntel";

// The bundler cannot resolve MapLibre's worker from import.meta.url; see scripts/copy-worker.mjs.
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

const STYLE = "https://tiles.openfreemap.org/styles/dark";
// Layers of the OpenFreeMap dark style that compete with our marks: regions, small places, minor roads, rail.
const CLUTTER = [
  "place_state", "place_suburb", "place_other", "place_village", "place_town",
  "highway_minor", "highway_path", "highway_name_other", "highway_name_motorway", "highway_name_minor",
  "road_oneway", "road_oneway_opposite",
  "railway", "railway_dashline", "railway_transit", "railway_transit_dashline", "railway_minor", "railway_minor_dashline",
  "building", "landuse_residential", "poi_r20", "poi_r7", "poi_r1", "poi_transit",
];

export type LocationHint = { lat: number; lon: number; label: string };
const DEFAULT_ORIGIN: Origin = { lat: 45.6579, lon: 25.6012, label: "Brașov", source: "default" };

type RGBA = [number, number, number, number];
const MINT: RGBA = [111, 240, 196, 255];
const INK: RGBA = [238, 242, 255, 235];
export function arcColor(min: number): RGBA {
  if (min < 120) return [124, 196, 255, 200];
  if (min < 300) return [255, 180, 84, 200];
  return [255, 107, 138, 180];
}
export function priceColor(eur: number): RGBA {
  if (eur < 60) return [111, 240, 196, 240];
  if (eur < 150) return [238, 242, 255, 220];
  return [160, 170, 195, 180];
}
const DIM: RGBA = [140, 150, 170, 70];
export function tempColor(c: number): RGBA {
  if (c < 10) return [96, 140, 240, 220];
  if (c < 20) return [124, 196, 255, 220];
  if (c < 27) return [255, 180, 84, 230];
  return [255, 107, 138, 230];
}

const TOOLTIP_STYLE = {
  background: "rgba(14,18,32,0.92)",
  color: "#eef2ff",
  fontSize: "12px",
  lineHeight: "1.35",
  padding: "8px 10px",
  borderRadius: "10px",
  border: "1px solid rgba(255,255,255,0.1)",
  maxWidth: "260px",
  fontFamily: "var(--font-geist), system-ui, sans-serif",
};

function changesText(n: number | undefined): string {
  return n ? `${n} change${n === 1 ? "" : "s"}` : "direct";
}

type DealDot = { d: Deal; t: [number, number] };
type Picked = Place | Destination | Gateway | Origin | ReachStation | TripCity | DealDot | Sight;
function isTripCity(o: Picked): o is TripCity {
  return "code" in o && "country" in o && !("key" in o) && !("airport" in o);
}

function tooltip(info: PickingInfo): null | { html: string; style: Record<string, string> } {
  const o = info.object as Picked | undefined;
  if (!o) return null;
  let html: string;
  if ("desc" in o && "kind" in o) {
    const s = o as Sight;
    html = `<b>${s.name}</b>${s.desc ? `<br/>${s.desc.slice(0, 140)}` : ""}`;
  } else if ("d" in o && "t" in o) {
    html = `<b>${o.d.city}</b>, ${countryName(o.d.country)}<br/><b style="color:#6ff0c4">€${o.d.price}</b> return · ${dateRange(o.d.out, o.d.back)} · ${o.d.nights} nights · from ${o.d.gw}`;
  } else if (isTripCity(o)) {
    html = `<b>${o.name}</b>, ${countryName(o.country)}`;
  } else if ("key" in o) {
    const where = [o.name, o.country ? countryName(o.country) : ""].filter(Boolean).join(", ");
    const alt = o.mode === "plane" && o.ground ? `<br/>or ${formatDuration(o.ground.minutes)} by ${o.ground.mode}` : o.mode !== "plane" && o.air ? `<br/>or ~${formatDuration(o.air.minutes)} flying via ${o.air.gateway.iata}` : "";
    html = `<b>${where}</b><br/>${MODE_LABEL[o.mode]} · ${formatDuration(o.minutes)}${o.mode === "plane" ? ` via ${o.air?.gateway.iata}` : ` · ${changesText(o.changes)}`}${o.price != null ? ` · <b>from €${o.price}</b>` : ""}${alt}`;
  } else if ("changes" in o) {
    html = `<b>${o.name}</b><br/>${formatDuration(o.minutes)} · ${changesText(o.changes)} · by ${o.mode}`;
  } else if ("from" in o) {
    const where = [o.airport.city, countryName(o.airport.country)].filter(Boolean).join(", ");
    const fare = o.fare ? `<b>from €${o.fare.price}</b> · ${o.fare.departureAt} · ${o.fare.transfers ? `${o.fare.transfers} stop` : "direct"}<br/>` : "";
    html = `<span class="code">${o.airport.iata}</span> ${where}<br/>${fare}~${formatDuration(flightMinutes(o.km))} flight · ${Math.round(o.km)} km`;
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
  const baseLayersRef = useRef<Layer[]>([]);
  const trailRef = useRef<{ path: [number, number][]; timestamps: number[] } | null>(null);
  const originRef = useRef<Origin | null>(null);
  const sheetRef = useRef<Sheet>("half");

  const [airports, setAirports] = useState<Airport[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [airlines, setAirlines] = useState<Record<string, string>>({});
  const [cities, setCities] = useState<Record<string, City>>({});
  const [countries, setCountries] = useState<Record<string, CountryInfo>>({});
  const [holidays, setHolidays] = useState<Record<string, Holiday[]>>({});
  const [weather, setWeather] = useState<WeatherFile | null>(null);
  const [cityPlaces, setCityPlaces] = useState<Record<string, CityPlaces>>({});
  const [heritage, setHeritage] = useState<HeritageRow[]>([]);
  const [fame, setFame] = useState<FameFile | null>(null);
  const [visa, setVisa] = useState<VisaFile | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [mapObj, setMapObj] = useState<maplibregl.Map | null>(null);
  const [sights, setSights] = useState<Sights | null>(null);
  const [eats, setEats] = useState<EatsResponse | null>(null);
  const [hotels, setHotels] = useState<HotelsResult | null>(null);
  const [sightsOnMap, setSightsOnMap] = useState(false);
  const [combos, setCombos] = useState<CombosState>({ status: "idle" });
  const [selectedCombo, setSelectedCombo] = useState<string | null>(null);
  const [wild, setWild] = useState<WildState>({ status: "idle", lines: [] });
  const [wildRegion, setWildRegion] = useState("sea");
  const [wildNights, setWildNights] = useState(14);
  const [wildStyle, setWildStyle] = useState("experiences");
  const [wildBudget, setWildBudget] = useState("mid");
  const [plan, setPlan] = useState<PlanState>({ status: "idle" });

  const [boards, setBoards] = useState<Record<string, BoardState>>({});
  const [month, setMonth] = useState<string | null>(null);
  const [selectedDeal, setSelectedDeal] = useState<string | null>(null);
  const [hoveredDeal, setHoveredDeal] = useState<string | null>(null);
  const [dealNights, setDealNights] = useState<DealNights>("any");
  const [directOnly, setDirectOnly] = useState(false);
  const [gemsOnly, setGemsOnly] = useState(false);
  const [dealGateway, setDealGateway] = useState<string>("all");
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [ask, setAsk] = useState<AskState | null>(null);
  const [asking, setAsking] = useState(false);
  const [askOnly, setAskOnly] = useState(true);
  const [events, setEvents] = useState<{ name: string; date: string; venue?: string; kind?: string; url: string }[]>([]);
  const [liveSearch, setLiveSearch] = useState<LiveSearch | null>(null);
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
  const [sheet, setSheet] = useState<Sheet>("half");
  const [copied, setCopied] = useState(false);
  const [reach, setReach] = useState<ReachResponse | null>(null);
  const [selectedStation, setSelectedStation] = useState<number | null>(null);
  const [selectedPlace, setSelectedPlace] = useState<string | null>(null);
  const [trips, setTrips] = useState<TripsResult | null>(null);
  const [selectedTrip, setSelectedTrip] = useState<string | null>(null);
  const [days, setDays] = useState(5);
  sheetRef.current = sheet;

  // Keep the interesting part of the globe clear of the panel: right of it on desktop, above
  // the sheet on phones.
  const panelPadding = useCallback(() => {
    if (typeof window !== "undefined" && window.innerWidth <= 720) {
      const s = sheetRef.current;
      return { left: 16, right: 16, top: 70, bottom: (s === "peek" ? 150 : Math.round(window.innerHeight * 0.56)) + 24 };
    }
    return { left: 460, top: 84, right: 60, bottom: 60 };
  }, []);

  // Re-price one route on Kiwi for the dates the visitor picks.
  async function searchLive(from: string, to: string, depart: string, nights: number) {
    setLiveSearch({ status: "loading", from, to, depart, nights, itineraries: [] });
    try {
      const r = await fetch(`/api/deals?from=${from}&to=${to}&depart=${depart}&nights=${nights}&flex=2`);
      const j = (await r.json()) as { itineraries?: LiveSearch["itineraries"]; error?: string; fetchedAt?: string };
      if (!r.ok || j.error) setLiveSearch({ status: "error", from, to, depart, nights, itineraries: [], note: j.error ?? `search failed (${r.status})` });
      else setLiveSearch({ status: "ok", from, to, depart, nights, itineraries: j.itineraries ?? [], fetchedAt: j.fetchedAt });
    } catch {
      setLiveSearch({ status: "error", from, to, depart, nights, itineraries: [], note: "search failed" });
    }
  }

  // Static data, produced by scripts/ingest and committed under public/data. A file that an
  // ingest has not produced yet is simply absent, never a broken globe.
  const extrasLoaded = useRef(false);
  const load = (f: string) =>
    fetch(`/data/${f}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  useEffect(() => {
    Promise.all([load("airports.json"), load("cities.json"), load("countries.json"), load("weather.json"), load("city-places.json"), load("heritage.json"), load("manifest.json"), load("fame.json")]).then(
      ([a, c, co, w, cp, he, m, fa]) => {
        setAirports(a ?? []);
        setCities(c ?? {});
        setCountries(co ?? {});
        setWeather(w && (w as WeatherCompact).syms ? expandWeather(w as WeatherCompact) : null);
        setCityPlaces(cp ?? {});
        setHeritage(he ?? []);
        setManifest(m);
        setFame(fa);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (extrasLoaded.current) return;
    if (view === "deals" && !selectedDeal) return;
    extrasLoaded.current = true;
    Promise.all([load("routes-openflights.json"), load("airlines.json"), load("holidays.json"), load("visa.json")]).then(([r, al, h, vi]) => {
      setRoutes(r ?? []);
      setAirlines(al ?? {});
      setHolidays(h ?? {});
      setVisa(vi);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedDeal]);

  // The address bar follows the globe, so any view is a link.
  useEffect(() => {
    if (!origin) return;
    const q = new URLSearchParams();
    q.set("from", `${origin.lat.toFixed(3)},${origin.lon.toFixed(3)},${origin.label}`);
    if (month) q.set("month", month);
    if (view !== "deals") q.set("view", view);
    if (view === "trips" && days !== 5) q.set("days", String(days));
    if (selectedPlace && view !== "deals") q.set("place", selectedPlace);
    if (selectedDeal && view === "deals") q.set("deal", selectedDeal);
    if (selectedTrip && view === "trips") q.set("trip", selectedTrip);
    const url = `${window.location.pathname}?${q.toString()}`;
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", url);
  }, [origin, month, view, days, selectedPlace, selectedDeal, selectedTrip]);

  const cityOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const [code, c] of Object.entries(cities)) for (const iata of c.airports) m.set(iata, code);
    return m;
  }, [cities]);

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
  // position when allowed, a fixed city when nothing else.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const m = q.get("month");
    if (m && /^\d{4}-\d{2}$/.test(m)) setMonth(m);
    const from = q.get("from")?.split(",");
    const v = q.get("view");
    if (v === "deals" || v === "all" || v === "fly" || v === "ground" || v === "trips" || v === "wild") setView(v);
    if (from && from.length >= 2 && Number.isFinite(Number(from[0])) && Number.isFinite(Number(from[1]))) {
      setOrigin({ lat: Number(from[0]), lon: Number(from[1]), label: from.slice(2).join(",") || "shared location", source: "search" });
      const d = Number(q.get("days"));
      if ([3, 5, 7, 10].includes(d)) setDays(d);
      const place = q.get("place");
      if (place) setSelectedPlace(place);
      const deal = q.get("deal");
      if (deal) setSelectedDeal(deal);
      const trip = q.get("trip");
      if (trip) setSelectedTrip(trip);
      return;
    }
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

  const gateways = useMemo<Gateway[]>(() => (origin ? nearestGateways(airports, origin.lat, origin.lon) : []), [airports, origin]);

  const routeCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const g of gateways) out[g.airport.iata] = routesFrom.get(g.airport.iata)?.length ?? 0;
    return out;
  }, [gateways, routesFrom]);

  useEffect(() => {
    if (!gateways.length || gateways.some((g) => g.airport.iata === gatewayIata)) return;
    const usable = gateways.filter((g) => routeCounts[g.airport.iata] > 0);
    if (!usable.length) {
      setGatewayIata(gateways[0].airport.iata);
      return;
    }
    const nearest = Math.min(...usable.map((g) => g.driveMin));
    const best = usable.filter((g) => g.driveMin <= nearest + 45).sort((a, b) => routeCounts[b.airport.iata] - routeCounts[a.airport.iata])[0];
    setGatewayIata(best.airport.iata);
  }, [gateways, gatewayIata, routeCounts]);

  const gateway = gatewayIata ? (byIata.get(gatewayIata) ?? null) : null;

  // The airports whose boards we show: the nearest, plus up to two bigger ones within 250 km.
  const boardGateways = useMemo(() => {
    if (!gateways.length) return [] as { iata: string; label: string }[];
    const sizeRank = (a: Airport) => (a.size === "large" ? 0 : a.size === "medium" ? 1 : 2);
    // Airfields with a handful of flights a week are not worth a search of their own unless
    // nothing bigger is within reach (Cascais next to Lisbon, Ghimbav next to Sibiu and Otopeni).
    const near = gateways.filter((g) => g.km <= 250);
    const real = near.filter((g) => g.airport.size !== "small");
    const first = real[0] ?? near[0] ?? gateways[0];
    const rest = (real.length ? real : near)
      .filter((g) => g !== first)
      .sort((a, b) => sizeRank(a.airport) - sizeRank(b.airport) || a.km - b.km)
      .slice(0, 2);
    return [first, ...rest].map((g) => ({ iata: g.airport.iata, label: g.airport.city ?? g.airport.name }));
  }, [gateways]);
  const boardKey = boardGateways.map((g) => g.iata).join(",");

  // Boards: stored ones arrive whole, live ones stream in search by search.
  useEffect(() => {
    if (!boardGateways.length) return;
    const ctrl = new AbortController();
    setBoards(Object.fromEntries(boardGateways.map((g) => [g.iata, { gateway: g.iata, label: g.label, status: "loading", deals: [] } satisfies BoardState])));
    setDealGateway("all");
    for (const g of boardGateways) {
      fetchBoard(
        g.iata,
        month,
        {
          deals: (ds) =>
            setBoards((b) => {
              const cur = b[g.iata];
              if (!cur) return b;
              const seen = new Set(cur.deals.map(dealKey));
              const add = ds.filter((d) => !seen.has(dealKey(d)));
              return add.length ? { ...b, [g.iata]: { ...cur, deals: [...cur.deals, ...add] } } : b;
            }),
          done: (meta, source) => setBoards((b) => (b[g.iata] ? { ...b, [g.iata]: { ...b[g.iata], status: "ok", source, meta } } : b)),
          error: (note) => setBoards((b) => (b[g.iata] ? { ...b, [g.iata]: { ...b[g.iata], status: "error", note } } : b)),
        },
        ctrl.signal,
      );
    }
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardKey, month]);
  const boardList = useMemo(() => boardGateways.map((g) => boards[g.iata]).filter((b): b is BoardState => !!b), [boardGateways, boards]);
  const searching = boardList.some((b) => b.status === "loading");

  // Cached one-way fares for every gateway (Explore).
  useEffect(() => {
    if (!gateways.length || view === "deals") return;
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
  }, [gateways, view]);

  const fares = gatewayIata ? (faresByGateway[gatewayIata] ?? null) : null;
  const live = fares?.status === "ok" && fares.origin === gateway?.iata;

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

  const wantReach = view === "all" || view === "ground" || view === "trips";
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
  const reachShown = useMemo(() => {
    const seen = new Set<string>();
    return reachBand.filter((s) => !seen.has(s.name) && seen.add(s.name));
  }, [reachBand]);

  const places = useMemo<Place[]>(
    () => (view === "all" && origin ? combinePlaces({ origin, gateways, routesFrom, byIata, cities, cityOf, faresByGateway, reach }) : []),
    [view, origin, gateways, routesFrom, byIata, cities, cityOf, faresByGateway, reach],
  );
  const placesShown = useMemo(() => {
    const b = BANDS.find((x) => x.key === band);
    return places.filter((p) => (!b || b.test(p.minutes)) && (!pricedOnly || p.price != null) && (!bigOnly || p.air || p.importance >= 0.33) && (!warmOnly || (weekendMax(cityCodeFor(p)) ?? -99) >= 20));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, band, pricedOnly, bigOnly, warmOnly, cities, weather]);

  // ---- deals ----
  const dealsAll = useMemo(() => boardList.flatMap((b) => b.deals), [boardList]);
  const dealCoord = useCallback(
    (d: Deal): [number, number] | null => {
      const c = cities[d.dstCity] ?? cities[d.dst];
      if (c) return [c.lon, c.lat];
      const a = byIata.get(d.dst);
      return a ? [a.lon, a.lat] : null;
    },
    [cities, byIata],
  );
  const gwCoord = useCallback(
    (code: string): [number, number] | null => {
      const a = byIata.get(code);
      if (a) return [a.lon, a.lat];
      const c = cities[code];
      return c ? [c.lon, c.lat] : null;
    },
    [cities, byIata],
  );
  const heritageCache = useRef(new Map<string, number>());
  const heritageNear = useCallback(
    (code: string, lat: number, lon: number): number => {
      const hit = heritageCache.current.get(code);
      if (hit != null) return hit;
      const n = heritage.filter((h) => Math.abs(h[1] - lat) < 0.5 && haversineKm(lat, lon, h[1], h[2]) <= 40).length;
      heritageCache.current.set(code, n);
      return n;
    },
    [heritage],
  );
  useEffect(() => {
    heritageCache.current.clear();
  }, [heritage]);
  const gemOf = useCallback(
    (d: Deal): boolean => {
      const c = dealCoord(d);
      return !!c && isGem(fame, d.dstCity, heritageNear(d.dstCity, c[1], c[0]), cityPlaces[d.dstCity]);
    },
    [fame, dealCoord, heritageNear, cityPlaces],
  );

  const dealsShown = useMemo<Deal[]>(() => {
    const range: Record<DealNights, [number, number]> = { any: [0, 99], "2-3": [2, 3], "4-5": [4, 5], "6-7": [6, 7] };
    const [lo, hi] = range[dealNights];
    const seen = new Set<string>();
    const out: Deal[] = [];
    for (const d of [...dealsAll].sort((a, b) => a.price - b.price)) {
      if (d.nights < lo || d.nights > hi) continue;
      if (directOnly && d.stops > 0) continue;
      if (dealGateway !== "all" && d.gw !== dealGateway) continue;
      if (warmOnly && (weekendMax(d.dstCity) ?? -99) < 20) continue;
      if (gemsOnly && !gemOf(d)) continue;
      if (seen.has(d.dstCity)) continue;
      seen.add(d.dstCity);
      out.push(d);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealsAll, dealNights, directOnly, dealGateway, warmOnly, gemsOnly, gemOf, weather]);
  const dealsList = useMemo<Deal[]>(() => {
    if (!askOnly || !ask?.used.length) return dealsShown;
    const used = new Set(ask.used);
    return dealsAll.filter((d) => used.has(dealKey(d))).sort((a, b) => a.price - b.price);
  }, [dealsShown, dealsAll, ask, askOnly]);
  const deal = selectedDeal ? (dealsAll.find((d) => dealKey(d) === selectedDeal) ?? null) : null;
  const dealOptions = useMemo(() => (deal ? dealsAll.filter((d) => d.dstCity === deal.dstCity).sort((a, b) => a.price - b.price).slice(0, 8) : []), [deal, dealsAll]);

  async function askAgent(question: string) {
    setAsking(true);
    setSelectedDeal(null);
    setAskOnly(true);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          home: gateways[0]?.airport.country ?? "RO",
          gateways: boardGateways.map((g) => g.iata),
          month,
          origin: origin ? { lat: origin.lat, lon: origin.lon, label: origin.label } : undefined,
        }),
      });
      const j = (await r.json()) as { status: string; text: string; used: string[]; note?: string };
      setAsk({ ...j, used: j.used ?? [], question });
    } catch {
      setAsk({ status: "error", text: "", used: [], note: "The agent did not answer.", question });
    } finally {
      setAsking(false);
    }
  }

  // One short badge: the single best reason to go, from what we know about the city.
  const whyOf = (d: Deal): string => {
    const c = dealCoord(d);
    if (!c) return "";
    const near = heritageNear(d.dstCity, c[1], c[0]);
    if (near) return near === 1 ? "World Heritage" : `${near} World Heritage sites`;
    const p = cityPlaces[d.dstCity];
    if (p?.food && p.food >= 1000) return `${(p.food / 1000).toFixed(1)}k restaurants`;
    if (p?.night && p.night >= 100) return "nightlife";
    if (p?.nature && p.nature >= 150) return "parks and nature";
    return "";
  };

  // Photos for cards without a Kiwi image: Wikivoyage thumbnails, fetched lazily and kept.
  useEffect(() => {
    if (view !== "deals") return;
    const missing = dealsShown
      .slice(0, 40)
      .filter((d) => !d.img)
      .map((d) => d.city)
      .filter((name, i, arr) => !(name in thumbs) && arr.indexOf(name) === i);
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

  // Everything we know about the selected city and country.
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
      fame: code ? fame?.[code] : undefined,
      visa: visa && countryCode && gateways[0] && gateways[0].airport.country !== countryCode ? { passport: gateways[0].airport.country, text: visaFor(visa, gateways[0].airport.country, countryCode), updated: visa.updated } : undefined,
      heritage: heritage
        .filter((h) => Math.abs(h[1] - target.lat) < 0.8)
        .map((h) => ({ name: h[0], km: Math.round(haversineKm(target.lat, target.lon, h[1], h[2])) }))
        .filter((h) => h.km <= 60)
        .sort((a, b) => a.km - b.km)
        .slice(0, 3),
      events,
    };
  }, [target, cities, countries, weather, holidays, cityPlaces, heritage, visa, gateways, events, fame]);

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

  // What to see and do in the deal's city (Wikivoyage listings), and the combos on demand.
  useEffect(() => {
    setSights(null);
    setSightsOnMap(false);
    setCombos({ status: "idle" });
    setSelectedCombo(null);
    const name = deal?.city;
    if (!name) return;
    const ctrl = new AbortController();
    fetch(`/api/sights?name=${encodeURIComponent(name)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Sights | null) => setSights(j))
      .catch(() => {});
    return () => ctrl.abort();
  }, [deal?.city]);
  // Rated places to eat and live hotel prices for the deal's city and dates.
  useEffect(() => {
    setEats(null);
    setHotels(null);
    if (!deal) return;
    const c = dealCoord(deal);
    if (!c) return;
    const ctrl = new AbortController();
    fetch(`/api/eats?lat=${c[1].toFixed(4)}&lon=${c[0].toFixed(4)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: EatsResponse | null) => setEats(j))
      .catch(() => {});
    fetch(`/api/hotels?lat=${c[1].toFixed(4)}&lon=${c[0].toFixed(4)}&checkin=${deal.out}&checkout=${deal.back}&nat=${gateways[0]?.airport.country ?? "RO"}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: HotelsResult | null) => setHotels(j))
      .catch(() => {});
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deal?.dstCity, deal?.out, deal?.back]);
  async function findCombosFor() {
    if (!deal) return;
    setCombos({ status: "loading" });
    try {
      const r = await fetch(`/api/combos?gw=${deal.gw}&dst=${deal.dst}&city=${deal.dstCity}&out=${deal.out}&back=${deal.back}&price=${deal.price}`);
      const j = await r.json();
      if (!r.ok || j.error) setCombos({ status: "error", note: j.error ?? `failed (${r.status})` });
      else setCombos({ status: "ok", result: j });
    } catch {
      setCombos({ status: "error", note: "network" });
    }
  }
  function showSights() {
    const map = mapRef.current;
    const c = deal ? dealCoord(deal) : null;
    if (!map || !c) return;
    setSightsOnMap(true);
    map.flyTo({ center: c, zoom: 12.2, duration: 1800, padding: panelPadding() });
  }
  function focusCombo(code: string | null) {
    setSelectedCombo(code);
    const map = mapRef.current;
    const c = code ? combos.result?.combos.find((x) => x.code === code) : null;
    const g = deal ? gwCoord(deal.gw) : null;
    const t = deal ? dealCoord(deal) : null;
    if (!map || !c || !g || !t) return;
    const bounds = new maplibregl.LngLatBounds(g, g).extend(t).extend([c.lon, c.lat]);
    map.fitBounds(bounds, { padding: panelPadding(), maxZoom: 6, duration: 1300 });
  }

  // A wild trip: streamed progress, then the trip; stored ones come back whole.
  const wildCoord = useCallback((code: string): [number, number] | null => gwCoord(code) ?? (cities[code] ? [cities[code].lon, cities[code].lat] : null), [gwCoord, cities]);
  async function buildWildTrip() {
    if (!boardGateways.length || !gateways[0]) return;
    setWild({ status: "loading", lines: [] });
    setPlan({ status: "idle" });
    const q = new URLSearchParams({ g: boardGateways.map((g) => g.iata).join(","), home: gateways[0].airport.country, region: wildRegion, nights: String(wildNights), style: wildStyle, budget: wildBudget });
    if (month) q.set("month", month);
    try {
      const r = await fetch(`/api/wild?${q}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setWild({ status: "error", lines: [], note: j.error ?? `failed (${r.status})` });
        return;
      }
      if (!r.headers.get("content-type")?.includes("ndjson")) {
        const trip = (await r.json()) as WildTrip;
        setWild({ status: "ok", lines: [], trip, source: "stored" });
        frameWild(trip);
        return;
      }
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
          if (!line) continue;
          try {
            const msg = JSON.parse(line) as { progress?: string; trip?: WildTrip; error?: string };
            if (msg.progress) setWild((w) => ({ ...w, lines: [...w.lines, msg.progress!] }));
            if (msg.trip) {
              finished = true;
              setWild({ status: "ok", lines: [], trip: msg.trip, source: "live" });
              frameWild(msg.trip);
            }
            if (msg.error) {
              finished = true;
              setWild({ status: "error", lines: [], note: msg.error });
            }
          } catch {
            // partial line
          }
        }
      }
      if (!finished) setWild({ status: "error", lines: [], note: "the search stopped early; try again" });
    } catch {
      setWild({ status: "error", lines: [], note: "network" });
    }
  }
  async function planWild() {
    if (!boardGateways.length) return;
    setPlan({ status: "loading" });
    const q = new URLSearchParams({ g: boardGateways.map((g) => g.iata).join(","), region: wildRegion, nights: String(wildNights), style: wildStyle, budget: wildBudget });
    if (month) q.set("month", month);
    try {
      const r = await fetch(`/api/plan?${q}`);
      const j = (await r.json()) as Plan & { error?: string };
      if (!r.ok || j.error) setPlan({ status: "error", note: j.error ?? `failed (${r.status})` });
      else setPlan({ status: "ok", plan: j });
    } catch {
      setPlan({ status: "error", note: "network" });
    }
  }
  function frameWild(trip: WildTrip) {
    const map = mapRef.current;
    if (!map) return;
    const pts: [number, number][] = [];
    for (const s of trip.stops) pts.push([s.lon, s.lat]);
    const home = wildCoord(trip.home);
    if (home) pts.push(home);
    if (pts.length < 2) return;
    const bounds = new maplibregl.LngLatBounds(pts[0], pts[0]);
    for (const q of pts) bounds.extend(q);
    map.fitBounds(bounds, { padding: panelPadding(), maxZoom: 4.5, duration: 1600 });
  }

  const homeHolidays = useMemo(() => {
    const home = gateways[0]?.airport.country;
    if (!home) return [];
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
    return (holidays[home] ?? []).filter((h) => h.national && h.date >= today && h.date <= horizon).slice(0, 4);
  }, [gateways, holidays]);
  const anyFares = Object.values(faresByGateway).some((f) => f.status === "ok" && f.fares.length > 0);
  const fareSource = Object.values(faresByGateway).some((f) => f.note?.includes("Kiwi")) ? "one-way fares found on Kiwi.com (weekly search)" : "cached one-way fares from Aviasales searches";

  useEffect(() => {
    if (view !== "trips" || !gateways.length) return;
    const ctrl = new AbortController();
    setTrips(null);
    const g = gateways.map((x) => `${x.airport.iata}:${x.airport.lat}:${x.airport.lon}:${x.driveMin}`).join(",");
    const extra = around ? `&around=${around}` : "";
    fetch(`/api/trips?g=${g}&home=${gateways[0].airport.country}&days=${days}${extra}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((j: TripsResult) => {
        setTrips(j);
        setSelectedTrip((cur) => (cur && j.trips?.some((t) => t.id === cur) ? cur : (j.trips?.[0]?.id ?? null)));
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

  // Price tags on the globe: one per city shown, cheapest first; the open or hovered one wins.
  const labelItems = useMemo<LabelItem[]>(() => {
    if (view === "wild") {
      const t = wild.trip;
      if (!t) return [];
      return t.stops.map((st, i) => ({ key: `${st.code}-${i}`, lon: st.lon, lat: st.lat, text: `${st.name} · ${st.nights}n`, hot: i === 0, cheap: false }));
    }
    if (view !== "deals") return [];
    const out: LabelItem[] = [];
    for (const d of dealsList.slice(0, 80)) {
      const c = dealCoord(d);
      if (!c) continue;
      const key = dealKey(d);
      out.push({ key, lon: c[0], lat: c[1], text: `€${d.price}`, hot: key === selectedDeal || key === hoveredDeal, cheap: d.price < 60 });
    }
    if (deal && !out.some((x) => x.key === selectedDeal)) {
      const c = dealCoord(deal);
      if (c) out.unshift({ key: dealKey(deal), lon: c[0], lat: c[1], text: `€${deal.price}`, hot: true, cheap: deal.price < 60 });
    }
    out.sort((a, b) => (a.hot === b.hot ? 0 : a.hot ? -1 : 1));
    return out;
  }, [view, dealsList, deal, selectedDeal, hoveredDeal, dealCoord, wild.trip]);

  // Animated layers (the trail of the selected deal, the pulse at home) are rebuilt every
  // frame from refs; everything else is rebuilt when state changes.
  const render = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const t = performance.now() / 1000;
    const anim: Layer[] = [];
    const trail = trailRef.current;
    if (trail) {
      const n = trail.timestamps.length;
      const loop = n * 1.6;
      anim.push(
        new TripsLayer<{ path: [number, number][]; timestamps: number[] }>({
          id: "deal-trail",
          data: [trail],
          getPath: (d) => d.path,
          getTimestamps: (d) => d.timestamps,
          getColor: [111, 240, 196],
          currentTime: ((t * 28) % loop) as number,
          trailLength: n * 0.55,
          widthMinPixels: 3.5,
          capRounded: true,
          jointRounded: true,
          fadeTrail: true,
          parameters: { cullMode: "none" },
        }),
      );
    }
    const o = originRef.current;
    if (o) {
      const phase = (t % 2.2) / 2.2;
      anim.push(
        new ScatterplotLayer<Origin>({
          id: "origin-pulse",
          data: [o],
          getPosition: (x) => [x.lon, x.lat],
          radiusUnits: "pixels",
          getRadius: 6 + phase * 16,
          getFillColor: [124, 196, 255, Math.round(90 * (1 - phase))],
          stroked: false,
          updateTriggers: { getRadius: [phase], getFillColor: [phase] },
        }),
      );
    }
    overlay.setProps({ layers: [...baseLayersRef.current, ...anim] });
  }, []);

  // The map itself: created once, spins slowly until the user touches it.
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapEl.current,
      style: STYLE,
      center: [20, 25],
      zoom: 1.4,
      maxPitch: 60,
      attributionControl: { compact: true },
      canvasContextAttributes: { alpha: true, antialias: true },
    });
    map.on("style.load", () => {
      map.setProjection({ type: "globe" });
      map.setSky({
        "sky-color": "rgba(5,7,14,0)",
        "horizon-color": "#1f3f8a",
        "fog-color": "#0a1430",
        "fog-ground-blend": 0.6,
        "horizon-fog-blend": 0.7,
        "sky-horizon-blend": 0.95,
        "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0],
      });
      for (const id of CLUTTER) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
      // City names only once you are close enough for them to help.
      if (map.getLayer("place_city")) map.setLayerZoomRange("place_city", 4.2, 24);
      if (map.getLayer("water_name")) map.setLayerZoomRange("water_name", 5, 24);
      if (map.getLayer("water")) map.setPaintProperty("water", "fill-color", "#0b1328");
      if (map.getLayer("background")) map.setPaintProperty("background", "background-color", "#0f1526");
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
    const frame = () => {
      if (spinRef.current) {
        const c = map.getCenter();
        map.setCenter([c.lng + 0.04, c.lat]);
      }
      render();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    mapRef.current = map;
    overlayRef.current = overlay;
    setMapObj(map);
    return () => {
      cancelAnimationFrame(raf);
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
      setMapObj(null);
    };
  }, [render]);

  useEffect(() => {
    originRef.current = origin;
    const map = mapRef.current;
    if (!map || !origin) return;
    spinRef.current = false;
    map.flyTo({ center: [origin.lon, origin.lat], zoom: 2.9, duration: 2600, padding: panelPadding(), essential: true });
  }, [origin, panelPadding]);

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
    setLiveSearch(null);
    if (key && sheetRef.current === "peek") setSheet("half");
    const d = key ? dealsAll.find((x) => dealKey(x) === key) : null;
    const map = mapRef.current;
    const g = d ? gwCoord(d.gw) : null;
    const c = d ? dealCoord(d) : null;
    if (!map || !d || !g || !c) return;
    const bounds = new maplibregl.LngLatBounds(g, g).extend(c);
    map.fitBounds(bounds, { padding: panelPadding(), maxZoom: 5.5, duration: 1300 });
  }

  function focusGateway(iata: string) {
    setGatewayIata(iata);
    setSelectedDest(null);
    const map = mapRef.current;
    const g = byIata.get(iata);
    if (map && g) map.flyTo({ center: [g.lon, g.lat], zoom: Math.max(map.getZoom(), 3), duration: 1200, padding: panelPadding() });
  }

  function share() {
    navigator.clipboard?.writeText(window.location.href).then(
      () => setCopied(true),
      () => setCopied(false),
    );
    setTimeout(() => setCopied(false), 1600);
  }

  // The trail of the selected deal follows the great circle from its home airport.
  useEffect(() => {
    if (!deal) {
      trailRef.current = null;
      return;
    }
    const g = gwCoord(deal.gw);
    const c = dealCoord(deal);
    if (!g || !c) {
      trailRef.current = null;
      return;
    }
    const path = greatCircle(g, c, 72);
    trailRef.current = { path, timestamps: path.map((_, i) => i) };
  }, [deal, gwCoord, dealCoord]);

  // deck.gl layers follow the state. Globe needs back-face culling off or arcs disappear.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const colorOf = (d: Destination): RGBA => (live ? (d.fare ? priceColor(d.fare.price) : DIM) : arcColor(flightMinutes(d.km)));
    const ground = view === "ground";
    const all = view === "all";
    const fly = view === "fly";
    const tripView = view === "trips";
    const dealView = view === "deals";
    const wildView = view === "wild";
    const wildTrip = wildView ? wild.trip : undefined;
    const flownPlaces = placesShown.filter((p) => p.mode === "plane" && p.air && p.key === selectedPlace);
    const dealDots: DealDot[] = dealView ? dealsList.map((d) => ({ d, t: dealCoord(d) })).filter((x): x is DealDot => !!x.t) : [];
    if (dealView && deal && !dealDots.some((x) => dealKey(x.d) === selectedDeal)) {
      const t = dealCoord(deal);
      if (t) dealDots.push({ d: deal, t });
    }
    const selectedDot = deal ? dealDots.find((x) => dealKey(x.d) === selectedDeal) : null;
    const selectedGw = deal ? gwCoord(deal.gw) : null;
    const combo = selectedCombo && combos.status === "ok" ? (combos.result?.combos.find((x) => x.code === selectedCombo) ?? null) : null;
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
    const isHot = (x: DealDot) => dealKey(x.d) === selectedDeal || dealKey(x.d) === hoveredDeal;

    const layers: (Layer | null)[] = [
      dealView && selectedDot && selectedGw
        ? new PathLayer<{ path: [number, number][] }>({
            id: "deal-arc",
            data: [{ path: greatCircle(selectedGw, selectedDot.t, 72) }],
            getPath: (d) => d.path,
            getColor: [111, 240, 196, 70],
            getWidth: 1.5,
            widthUnits: "pixels",
            parameters: { cullMode: "none" },
          })
        : null,
      dealView && selectedGw
        ? new ScatterplotLayer<{ p: [number, number] }>({
            id: "deal-home",
            data: [{ p: selectedGw }],
            getPosition: (x) => x.p,
            radiusUnits: "pixels",
            getRadius: 5,
            getFillColor: [124, 196, 255, 255],
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: 2,
            getLineColor: [255, 255, 255, 220],
          })
        : null,
      dealView
        ? new ScatterplotLayer<DealDot>({
            id: "deal-dots",
            data: dealDots,
            getPosition: (x) => x.t,
            radiusUnits: "pixels",
            getRadius: (x) => (dealKey(x.d) === selectedDeal ? 9 : dealKey(x.d) === hoveredDeal ? 8 : x.d.price < 60 ? 5.5 : x.d.price < 150 ? 4.5 : 3.5),
            getFillColor: (x) => (isHot(x) ? MINT : priceColor(x.d.price)),
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: (x) => (isHot(x) ? 2 : 1),
            getLineColor: [255, 255, 255, 180],
            pickable: true,
            updateTriggers: { getRadius: [selectedDeal, hoveredDeal], getFillColor: [selectedDeal, hoveredDeal], getLineWidth: [selectedDeal, hoveredDeal] },
            onClick: (info) => focusDeal(info.object ? dealKey((info.object as DealDot).d) : null),
          })
        : null,
      dealView && combo && selectedGw && selectedDot
        ? new PathLayer<{ path: [number, number][] }>({
            id: "combo-ground",
            data: [{ path: [selectedDot.t, [combo.lon, combo.lat]] }],
            getPath: (d) => d.path,
            getColor: [255, 180, 84, 230],
            getWidth: 3,
            widthUnits: "pixels",
            parameters: { cullMode: "none" },
          })
        : null,
      dealView && combo && selectedGw
        ? new ArcLayer<{ s: [number, number]; t: [number, number] }>({
            id: "combo-home",
            data: [{ s: [combo.lon, combo.lat], t: selectedGw }],
            getSourcePosition: (x) => x.s,
            getTargetPosition: (x) => x.t,
            getSourceColor: [255, 180, 84, 220],
            getTargetColor: [255, 180, 84, 220],
            getWidth: 2.5,
            greatCircle: true,
            parameters: { cullMode: "none" },
          })
        : null,
      dealView && combo
        ? new ScatterplotLayer<{ p: [number, number] }>({
            id: "combo-city",
            data: [{ p: [combo.lon, combo.lat] }],
            getPosition: (x) => x.p,
            radiusUnits: "pixels",
            getRadius: 7,
            getFillColor: [255, 180, 84, 255],
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: 2,
            getLineColor: [255, 255, 255, 230],
          })
        : null,
      dealView && sightsOnMap && sights
        ? new ScatterplotLayer<Sight>({
            id: "sights",
            data: [...sights.see, ...sights.do].filter((x) => x.lat != null && x.lon != null),
            getPosition: (x) => [x.lon!, x.lat!],
            radiusUnits: "pixels",
            getRadius: (x) => (x.kind === "see" ? 6 : 5),
            getFillColor: (x) => (x.kind === "see" ? [111, 240, 196, 240] : [255, 180, 84, 240]),
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: 1.5,
            getLineColor: [5, 7, 14, 220],
            pickable: true,
          })
        : null,
      wildView && wildTrip
        ? new ArcLayer<{ s: [number, number]; t: [number, number] }>({
            id: "wild-arcs",
            data: wildTrip.legs
              .filter((l): l is Extract<WildLeg, { kind: "fly" }> => l.kind === "fly")
              .map((l) => ({ s: wildCoord(l.from), t: wildCoord(l.to) }))
              .filter((x): x is { s: [number, number]; t: [number, number] } => !!x.s && !!x.t),
            getSourcePosition: (x) => x.s,
            getTargetPosition: (x) => x.t,
            getSourceColor: [111, 240, 196, 230],
            getTargetColor: [255, 180, 84, 230],
            getWidth: 2.5,
            greatCircle: true,
            parameters: { cullMode: "none" },
          })
        : null,
      wildView && wildTrip
        ? new PathLayer<{ path: [number, number][] }>({
            id: "wild-ground",
            data: wildTrip.legs
              .filter((l): l is Extract<WildLeg, { kind: "ground" }> => l.kind === "ground")
              .map((l) => ({ path: [wildCoord(l.from), wildCoord(l.to)].filter((q): q is [number, number] => !!q) }))
              .filter((x) => x.path.length === 2),
            getPath: (d) => d.path,
            getColor: [255, 180, 84, 240],
            getWidth: 3,
            widthUnits: "pixels",
            parameters: { cullMode: "none" },
          })
        : null,
      wildView && wildTrip
        ? new ScatterplotLayer<WildTrip["stops"][number]>({
            id: "wild-stops",
            data: wildTrip.stops,
            getPosition: (st) => [st.lon, st.lat],
            radiusUnits: "pixels",
            getRadius: (st) => 5 + Math.min(4, st.nights),
            getFillColor: [111, 240, 196, 255],
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: 2,
            getLineColor: [5, 7, 14, 230],
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
            getColor: [124, 196, 255, 240],
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
        getRadius: (a) => (a.size === "large" ? 2.4 : a.size === "medium" ? 1.6 : 1),
        getFillColor: fly ? [150, 165, 190, 110] : [150, 165, 190, 38],
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
            getWidth: 4,
            greatCircle: true,
            parameters: { cullMode: "none" },
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
      !fly && !dealView && pathForSelected.length > 1
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
            getWidth: (d) => (d.airport.iata === selectedDest ? 4 : d.fare ? 2 : 1.2),
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
      ground || tripView || dealView || wildView
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
            getFillColor: [124, 196, 255, 255],
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: 1.5,
            getLineColor: [255, 255, 255, 230],
            pickable: true,
          })
        : null,
    ];
    baseLayersRef.current = layers.filter(Boolean) as Layer[];
    render();
    // focus* helpers only read refs and state setters; listing them would re-run this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [airports, shown, gateways, gatewayIata, origin, selectedDest, live, view, reachBand, selectedStation, pathForSelected, placesShown, selectedPlace, trips, trip, warmOnly, weather, dealsList, selectedDeal, hoveredDeal, deal, render, selectedCombo, combos, sightsOnMap, sights, wild.trip, wildCoord]);

  const groundFeeds = reach ? reach.feeds.map((f) => f.attribution.split(" via ")[0].split(" (")[0]).join(", ") : "";

  return (
    <div className="app">
      <div className="space" />
      <div ref={mapEl} className="map" />
      <PriceLabels map={mapObj} items={labelItems} onPick={focusDeal} onHover={setHoveredDeal} />
      <TopBar
        origin={origin}
        airports={airports}
        onOrigin={(a) => {
          setSelectedDest(null);
          setSelectedPlace(null);
          setSelectedDeal(null);
          setAsk(null);
          setOrigin({ lat: a.lat, lon: a.lon, label: a.city ?? a.name, source: "search" });
        }}
        month={month}
        onMonth={(m) => {
          setMonth(m);
          setSelectedDeal(null);
        }}
        searching={searching}
        asking={asking}
        onAsk={(q) => {
          setView("deals");
          askAgent(q);
        }}
        onShare={share}
        copied={copied}
      />
      <Panel
        view={view}
        onView={(v) => {
          setView(v);
          setSelectedDest(null);
          setSelectedStation(null);
          setSelectedPlace(null);
          setSelectedTrip(null);
          setSelectedDeal(null);
        }}
        sheet={sheet}
        onSheet={setSheet}
        origin={origin}
        month={month}
        boards={boardList}
        deals={dealsList}
        totalCities={dealsShown.length}
        deal={deal}
        dealOptions={dealOptions}
        onDeal={focusDeal}
        onHoverDeal={setHoveredDeal}
        dealNights={dealNights}
        onDealNights={setDealNights}
        directOnly={directOnly}
        onDirectOnly={setDirectOnly}
        warmOnly={warmOnly}
        onWarmOnly={setWarmOnly}
        gemsOnly={gemsOnly}
        onGemsOnly={setGemsOnly}
        dealGateway={dealGateway}
        onDealGateway={setDealGateway}
        gemOf={gemOf}
        whyOf={whyOf}
        warmOf={(d) => weekendMax(d.dstCity)}
        thumbs={thumbs}
        live={liveSearch}
        onLive={searchLive}
        ask={ask}
        asking={asking}
        onAsk={askAgent}
        askOnly={askOnly}
        onAskOnly={setAskOnly}
        weatherReady={!!weather}
        intel={intel}
        summary={summary}
        sights={sights}
        onShowSights={showSights}
        eats={eats}
        hotels={hotels}
        combos={combos}
        onCombos={findCombosFor}
        selectedCombo={selectedCombo}
        onCombo={focusCombo}
        wild={wild}
        wildRegion={wildRegion}
        onWildRegion={setWildRegion}
        wildNights={wildNights}
        onWildNights={setWildNights}
        wildStyle={wildStyle}
        onWildStyle={setWildStyle}
        wildBudget={wildBudget}
        onWildBudget={setWildBudget}
        onWild={buildWildTrip}
        plan={plan}
        onPlan={planWild}
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
        fares={fares}
        anyFares={anyFares}
        fareSource={fareSource}
        airlines={airlines}
        pricedOnly={pricedOnly}
        onPricedOnly={setPricedOnly}
        bigOnly={bigOnly}
        onBigOnly={setBigOnly}
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
          Prices: Kiwi.com, searched nightly · Airports: {manifest.airports?.source}
          {wantReach && reach ? ` · Ground: ${reach.feeds.length} GTFS feeds (${groundFeeds}), expected times` : ""}
          {weather ? ` · Weather: MET Norway ${weather.updated.slice(0, 10)}` : ""}
          {` · ${Object.keys(manifest).length} sources, hover for all`}
        </div>
      )}
    </div>
  );
}

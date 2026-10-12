"use client";

// The app around one search (docs/plans/one-search.md): the globe, the top bar and the panel
// with its three tabs (Search, Ask, My trips). The Search tab owns the bar and the list; this
// shell owns everything the tabs share: where the traveller is, their airports, the trip
// style and Been, the globe (results as price tags, the lit trip's route, a walk drawn while
// it thinks), the trip page, place pages, the itinerary view and the chat's picks.
//
// Every way of asking ends as one SearchQuery handed to the Search tab: the bar itself, the
// command line (runCommand), an 'atlas:search' event (the chat, a saved search), an old link
// (?view=deals, ?mode=wild, ?deal=...). Opening any result, from the list, the globe or the
// chat ('atlas:trip'), shows the trip page in the panel.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import { ArcLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import { PathStyleExtension } from "@deck.gl/extensions";
import type { Layer, PickingInfo } from "@deck.gl/core";
import { haversineKm, nearestGateways } from "@/lib/geo";
import type { PlaceSummary } from "@/app/api/place/route";
import { readNdjson } from "@/lib/boards-client";
import { greatCircle, latitudeLines, routePath, type RouteLeg } from "@/lib/arc";
import type { FameFile } from "@/lib/gems";
import { addDays, countryName, daysBetween, localIso, shortDate, todayIso } from "@/lib/format";
import { EMPTY_BEEN, excludedCountries, loadBeen, saveBeen, type BeenPrefs } from "@/lib/been";
import { REGION_CENTROIDS, WILD_REGIONS, EMPTY_WALK, WALK_MAX_EDGES, WALK_PARAM_KEYS, forgetSearch, loadSearches, rememberSearch, walkQueryString, type Origin, type Period, type PickMode, type PickedDetail, type PlacePage, type SavedSearch, type SearchRun, type SearchStatus, type SearchTabProps, type Sheet, type Tab, type WalkEdgeView, type WalkNodeView, type WalkQuery, type WalkState } from "@/lib/ui-types";
import { AVOID_GROUPS, avoidCodes, DEFAULT_PREFS, loadPrefs, PREFS_EVENT, cleanPrefs, type Prefs } from "@/lib/prefs";
import type { Airport, City, CityPlaces, CountryInfo, Deal, Gateway, HeritageRow, Holiday, Manifest, VisaFile, WeatherCompact, WeatherFile } from "@/lib/types";
import { expandWeather, visaFor } from "@/lib/types";
import Panel from "./Panel";
import { parseCommand, toSearchQuery, type Command } from "@/lib/command";
import type { WalkEvent, WalkLoop, WalkResult } from "@/lib/graph-walk";
import { skeletonFromWild, type ItinLeg, type ItinPlace, type Itinerary as Itin, type Pace, type BudgetTier, type Skeleton } from "@/lib/itinerary";
import { doorPrice, skeletonFromTrip as skeletonFromTripResult, tripFromDeal, tripFromRouteOption, searchQueryFromParams, searchQueryToParams, type Locate, type SearchQuery, type TripResult } from "@/lib/trip-result";
import type { RouteResult } from "@/lib/route-finder";
import { existingOwnerId } from "@/lib/owner";
import Itinerary, { type SavedItinerary } from "./Itinerary";
import type { EatsResponse } from "@/app/api/eats/route";
import type { WildStop, WildTrip } from "@/lib/wild";
import type { Sights, Sight } from "@/app/api/sights/route";
import TopBar from "./TopBar";
import type { ChatContext } from "./ChatPanel";
import PriceLabels, { type LabelItem } from "./PriceLabels";
import type { Intel } from "./PlaceIntel";

/** The origin as a place name the engines resolve: its name, or "lat,lon" when the name is only "your location". */
function originAsPlace(o: Origin): string {
  return o.label === "your location" || o.label === "shared location" ? `${o.lat.toFixed(3)},${o.lon.toFixed(3)}` : o.label;
}
/** What the itinerary view was opened with: a skeleton to generate, or an itinerary already written (a saved one). n keys the component, so a new open starts fresh. */
type ItinOpen = { skeleton?: Skeleton; itinerary?: Itin; wishes?: string; pace?: Pace; budget?: BudgetTier; savedId?: string; n: number };

/** One line of the /api/walk stream, and of a walk drawn from elsewhere ('atlas:walk-live'). */
type WalkLine = {
  node?: Omit<WalkNodeView, "at" | "money">;
  edge?: Omit<WalkEdgeView, "at" | "path">;
  loop?: { loop: WalkLoop } | WalkLoop;
  progress?: string;
  done?: WalkResult;
  error?: string;
};
/** A walk step in either spelling (the engine's typed WalkEvent, or the stream's keyed line) as the drawer reads it. */
function walkLineOf(e: WalkEvent | WalkLine): WalkLine {
  if (!("type" in e)) return e;
  switch (e.type) {
    case "node": {
      const { type: _t, ...node } = e;
      return { node };
    }
    case "edge": {
      const { type: _t, ...edge } = e;
      return { edge };
    }
    case "loop":
      return { loop: e.loop };
    case "progress":
      return { progress: e.text };
  }
}
/** Something a live search just found, drawn growing from where it leaves and fading out. */
type Arrival = { path: [number, number][]; at: number; color: RGBA };
const ARRIVAL_MS = 2600;
const EDGE_TAG_MS = 3500;
const EDGE_GROW_MS = 650;
const EDGE_FADE_MS = 3200;
const NODE_PULSE_MS = 2400;
const dashExt = new PathStyleExtension({ dash: true });
/** The first part of a path, so an arc can draw itself from where it leaves: t from 0 to 1. */
function growPath(path: [number, number][], t: number): [number, number][] {
  if (t >= 1 || path.length < 2) return path;
  const f = Math.max(0, t) * (path.length - 1);
  const i = Math.floor(f);
  const a = path[i];
  const b = path[Math.min(i + 1, path.length - 1)];
  const k = f - i;
  return [...path.slice(0, i + 1), [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]];
}
/** A straight ground line as points, so it can grow like an arc and dash evenly on the globe. */
function straightPath(a: [number, number], b: [number, number], n = 12): [number, number][] {
  return Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n] as [number, number]);
}
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** "Brașov" and "brasov" are one key for a place typed on the command line. */
function foldName(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
/** Region words a traveller types, to the Wild regions' keys; anything else is tried as a country, then a place. */
const REGION_WORDS: Record<string, string> = {
  "southeast asia": "sea", "south east asia": "sea", "se asia": "sea", asia: "sea", indochina: "sea",
  "east asia": "east-asia", "south asia": "south-asia", "central asia": "central-asia", "silk road": "central-asia", stans: "central-asia",
  caucasus: "caucasus", turkey: "caucasus", balkans: "balkans", "north africa": "north-africa", levant: "north-africa", "middle east": "gulf", gulf: "gulf",
  "east africa": "east-africa", africa: "east-africa", "southern africa": "southern-africa", "north america": "americas", "central america": "americas", america: "americas", americas: "americas",
  caribbean: "caribbean", "south america": "south-america", "latin america": "south-america", oceania: "oceania", australia: "oceania", pacific: "oceania",
};
function regionKey(word: string | undefined): string | null {
  if (!word) return null;
  const w = foldName(word);
  if (WILD_REGIONS.some((r) => r.key === w)) return w;
  const byLabel = WILD_REGIONS.find((r) => foldName(r.label) === w || foldName(r.label).startsWith(w));
  return byLabel?.key ?? REGION_WORDS[w] ?? null;
}
const LAT_LINES = latitudeLines(15);
const isPhone = () => typeof window !== "undefined" && window.innerWidth <= 720;
/** A point worth drawing: finite, and not the 0,0 an engine leaves for "unknown". */
const placed = (lat?: number, lon?: number): boolean => lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);

// The planner writes at most 60 days (lib/itinerary-server.ts): a longer trip is planned for
// its first four weeks, and the title says so, rather than sent and refused.
const PLAN_MAX_NIGHTS = 59;
function firstWeeks(sk: Skeleton): Skeleton {
  if (!sk.start || !sk.end || daysBetween(sk.start, sk.end) <= PLAN_MAX_NIGHTS) return sk;
  const end = addDays(sk.start, 28);
  const stops = sk.stops.filter((st) => st.arrive < end).map((st) => (st.leave > end ? { ...st, leave: end, nights: daysBetween(st.arrive, end) } : st));
  const legs = sk.legs.filter((l) => (l.date || sk.start) < end);
  return { ...sk, title: `${sk.title}: the first four weeks`, end, nights: daysBetween(sk.start, end), stops, legs };
}

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

/** A result on the globe: the trip and the point its tag and dot stand on (its longest stay). */
type ResultDot = { t: TripResult; p: [number, number] };
type Picked = ResultDot | Sight | Origin | Gateway;

function tooltip(info: PickingInfo): null | { html: string; style: Record<string, string> } {
  const o = info.object as Picked | undefined;
  if (!o) return null;
  let html: string;
  if ("desc" in o && "kind" in o) {
    const s = o as Sight;
    html = `<b>${s.name}</b>${s.desc ? `<br/>${s.desc.slice(0, 140)}` : ""}`;
  } else if ("t" in o && "p" in o) {
    const t = o.t;
    html = `<b>${t.title}</b><br/><b style="color:#6ff0c4">€${doorPrice(t)}</b> · ${t.back ? `${shortDate(t.out)} to ${shortDate(t.back)}` : shortDate(t.out)}${t.nights ? ` · ${t.nights} nights` : ""}`;
  } else if ("airport" in o) {
    html = `<span class="code">${o.airport.iata}</span> ${o.airport.name}`;
  } else {
    html = `You are here (${o.source})`;
  }
  return { html, style: TOOLTIP_STYLE };
}

// The city nearest a tap on the bare globe, within about thirty pixels at the current zoom
// (never under 30 km), so a place pick works on any town, not only on a pin.
function cityNearTap(cities: Record<string, City>, lat: number, lon: number, zoom: number): string | null {
  const metresPerPx = (156543.03 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
  const radiusKm = Math.max(30, (30 * metresPerPx) / 1000);
  let best: City | null = null;
  let bestKm = radiusKm;
  for (const c of Object.values(cities)) {
    if (Math.abs(c.lat - lat) * 111 > radiusKm) continue;
    const km = haversineKm(lat, lon, c.lat, c.lon);
    if (km < bestKm) {
      bestKm = km;
      best = c;
    }
  }
  return best?.name ?? null;
}

/** An old link, read once on load and turned into a search when the airports are known. */
type PendingLink = { kind: "query"; q: SearchQuery } | { kind: "deal"; key: string } | { kind: "view"; view: string; mode: string | null };

export default function Globe({ hint }: { hint?: LocationHint | null }) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapLibreOverlay | null>(null);
  const spinRef = useRef(true);
  const baseLayersRef = useRef<Layer[]>([]);
  const trailRef = useRef<{ path: [number, number][]; timestamps: number[] } | null>(null);
  const originRef = useRef<Origin | null>(null);
  const sheetRef = useRef<Sheet>("half");

  // ---- Static data, produced by scripts/ingest and committed under public/data. A file an
  // ingest has not produced yet is simply absent, never a broken globe.
  const [airports, setAirports] = useState<Airport[]>([]);
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
  useEffect(() => {
    const load = (f: string) =>
      fetch(`/data/${f}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    Promise.all([load("airports.json"), load("cities.json"), load("countries.json"), load("weather.json"), load("city-places.json"), load("heritage.json"), load("manifest.json"), load("fame.json")]).then(([a, c, co, w, cp, he, m, fa]) => {
      setAirports(a ?? []);
      setCities(c ?? {});
      setCountries(co ?? {});
      setWeather(w && (w as WeatherCompact).syms ? expandWeather(w as WeatherCompact) : null);
      setCityPlaces(cp ?? {});
      setHeritage(he ?? []);
      setManifest(m);
      setFame(fa);
      // What only a place page needs comes second, so the first screen does not wait for it.
      Promise.all([load("holidays.json"), load("visa.json")]).then(([h, vi]) => {
        setHolidays(h ?? {});
        setVisa(vi);
      });
    });
  }, []);

  // ---- The traveller: where they are, their trip style and their Been list.
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  useEffect(() => {
    setPrefs(loadPrefs());
    const onPrefs = (e: Event) => setPrefs(cleanPrefs((e as CustomEvent<{ prefs?: unknown }>).detail?.prefs));
    window.addEventListener(PREFS_EVENT, onPrefs);
    return () => window.removeEventListener(PREFS_EVENT, onPrefs);
  }, []);
  // "Been": browser only (localStorage), never in the URL.
  const [been, setBeenState] = useState<BeenPrefs>(EMPTY_BEEN);
  useEffect(() => {
    setBeenState(loadBeen());
  }, []);
  const setBeen = useCallback((p: BeenPrefs) => {
    setBeenState(p);
    saveBeen(p);
  }, []);
  const exclude = useMemo(() => excludedCountries(been), [been]);

  // ---- The panel.
  const [tab, setTab] = useState<Tab>("search");
  const tabRef = useRef<Tab>("search");
  tabRef.current = tab;
  const [sheet, setSheet] = useState<Sheet>("half");
  sheetRef.current = sheet;
  const [copied, setCopied] = useState(false);
  // A one-line note on the map (a command that could not run, a place not found); clears itself.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  // ---- The one search: the query handed to the Search tab, the list it shows (the globe
  // draws the same list), the trip lit on the globe and the trip page.
  const [searchRun, setSearchRun] = useState<SearchRun | null>(null);
  const [lastQuery, setLastQuery] = useState<SearchQuery | null>(null);
  const [results, setResults] = useState<TripResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>({ status: "idle" });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [openTrip, setOpenTrip] = useState<TripResult | null>(null);
  /** The query behind the open trip: the search that listed it, or, for a trip from the chat or the bus, the
   * traveller of now going anywhere. The trip page prices the way home and names the door from it. */
  const [openTripQuery, setOpenTripQuery] = useState<SearchQuery | null>(null);
  const lastQueryRef = useRef<SearchQuery | null>(null);
  lastQueryRef.current = lastQuery;
  /** A shared link's trip (?trip=<id>): opened when the link's search lists it (ids are stable). */
  const pendingTripRef = useRef<string | null>(null);
  /** An old ?place= link: its place page opens once the cities are known. */
  const pendingPlaceRef = useRef<string | null>(null);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  useEffect(() => setSaved(loadSearches()), []);
  /** The next finished answer frames the camera (once per search). */
  const frameNextRef = useRef(false);
  /** Ids already on the globe, so only a trip that just arrived draws its arc growing in. */
  const seenIdsRef = useRef(new Set<string>());

  // ---- Place pages, the itinerary view, the chat's picks and the route played by the camera.
  const [placePage, setPlacePage] = useState<PlacePage | null>(null);
  const [sights, setSights] = useState<Sights | null>(null);
  const [eats, setEats] = useState<EatsResponse | null>(null);
  const [summary, setSummary] = useState<PlaceSummary | null>(null);
  const [events, setEvents] = useState<{ name: string; date: string; venue?: string; kind?: string; url: string }[]>([]);
  const [sightsOnMap, setSightsOnMap] = useState(false);
  const [itin, setItin] = useState<ItinOpen | null>(null);
  const [itinShape, setItinShape] = useState<Skeleton | Itin | null>(null);
  const [hasSaved, setHasSaved] = useState(false);
  useEffect(() => {
    setHasSaved(!!existingOwnerId());
  }, []);
  const [pick, setPick] = useState<PickMode | null>(null);
  const [pickPeriod, setPickPeriod] = useState<Period>({ from: "", to: "" });
  const pickRef = useRef<PickMode | null>(null);
  pickRef.current = pick;
  const citiesRef = useRef<Record<string, City>>({});
  citiesRef.current = cities;
  const pickedRef = useRef<(d: PickedDetail) => void>(() => {});
  const [playing, setPlaying] = useState<number | null>(null);
  const playRef = useRef<{ timer: number; cancelled: boolean } | null>(null);
  const playStopRef = useRef<[number, number] | null>(null);
  const stopPlayRef = useRef<() => void>(() => {});
  const [lowZoom, setLowZoom] = useState(true);

  // ---- The chat: its deals and its loop show on the globe while the Ask tab is in front.
  const [chatDeals, setChatDeals] = useState<Deal[]>([]);
  const [chatTrip, setChatTrip] = useState<WildTrip | null>(null);
  const [chatSeed, setChatSeed] = useState<string | null>(null);

  // ---- The graph walk drawn while it thinks: GET /api/walk ('atlas:walk'), a walk the chat
  // or the search runs elsewhere ('atlas:walk-live'), a finished one ('atlas:walk-result').
  const [walk, setWalk] = useState<WalkState>(EMPTY_WALK);
  const [walkTab, setWalkTab] = useState<Tab>("chat");
  // Every walk starts with fresh params: the tab in front then is the one it answers.
  useEffect(() => {
    if (walk.params) setWalkTab(tabRef.current);
  }, [walk.params]);
  const walkCtrl = useRef<AbortController | null>(null);
  const walkNodesRef = useRef(new Map<string, { p: [number, number]; money?: number }>());
  const walkDrawRef = useRef<{ fly: WalkEdgeView[]; ground: WalkEdgeView[]; nodes: WalkNodeView[]; done: boolean; best: Set<string>; v: number } | null>(null);
  const walkLiveRef = useRef<{ id: string; draw: (m: WalkLine) => void } | null>(null);
  const [walkClock, setWalkClock] = useState(0);
  const arrivalsRef = useRef<Arrival[]>([]);
  const reducedRef = useRef(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    reducedRef.current = mq.matches;
    const on = () => (reducedRef.current = mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  // On a phone a sheet opened full hides the globe; anything that frames or flies the camera
  // drops it to half first, and reads the padding of that half through sheetRef at once.
  const revealMap = useCallback(() => {
    if (!isPhone() || sheetRef.current !== "full") return;
    sheetRef.current = "half";
    setSheet("half");
  }, []);
  // Keep the interesting part of the globe clear of the panel: right of it on desktop, above the sheet on phones.
  const panelPadding = useCallback(() => {
    if (typeof window !== "undefined" && window.innerWidth <= 720) {
      const s = sheetRef.current;
      const sheetBottom = (s === "peek" ? 150 : Math.round(window.innerHeight * 0.56)) + 24;
      return { left: 16, right: 16, top: 140, bottom: Math.min(sheetBottom, window.innerHeight - 140 - 160) };
    }
    const w = window.innerWidth;
    const css = getComputedStyle(document.documentElement);
    const panelW = parseFloat(css.getPropertyValue("--panel-w")) || 468;
    const topbar = parseFloat(css.getPropertyValue("--topbar")) || 64;
    const left = panelW + 36;
    const right = 60;
    return { left: Math.min(left, Math.max(40, w - right - 240)), top: topbar + 20, right, bottom: 60 };
  }, []);
  /** fitBounds adds its padding to what an earlier flyTo left on the map, so only the difference is asked for. */
  function fitPadding(map: maplibregl.Map, want: { left: number; right: number; top: number; bottom: number }) {
    const p0 = map.getPadding();
    return { left: Math.max(0, want.left - (p0.left ?? 0)), right: Math.max(0, want.right - (p0.right ?? 0)), top: Math.max(0, want.top - (p0.top ?? 0)), bottom: Math.max(0, want.bottom - (p0.bottom ?? 0)) };
  }
  function framePoints(pts: [number, number][], maxZoom: number, duration = 1500) {
    const map = mapRef.current;
    if (!map || pts.length === 0) return;
    revealMap();
    spinRef.current = false;
    const bounds = new maplibregl.LngLatBounds(pts[0], pts[0]);
    for (const q of pts) bounds.extend(q);
    map.fitBounds(bounds, { padding: fitPadding(map, panelPadding()), maxZoom, duration: reducedMotion() ? 0 : duration });
  }

  // ---- Where the user is: a shared link wins, then the network hint at once, the browser's
  // position when allowed, a fixed city when nothing else. Old links are read here too.
  const pendingLinkRef = useRef<PendingLink | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("tab");
    if (t === "chat" || t === "trips") setTab(t);
    const view = q.get("view");
    if (view === "chat") setTab("chat");
    // A search link: ours nests the query under q (the origin owns "from"); a readable one
    // written by searchQueryToParams alone (from, at, to, when...) is read whole.
    const sq = q.get("q");
    const parsed = sq ? searchQueryFromParams(sq) : q.get("at") && q.get("to") ? searchQueryFromParams(window.location.search) : null;
    const deal = q.get("deal");
    if (parsed) pendingLinkRef.current = { kind: "query", q: parsed };
    if (parsed && q.get("trip")) pendingTripRef.current = q.get("trip");
    if (!parsed && q.get("place")) pendingPlaceRef.current = q.get("place");
    else if (deal) pendingLinkRef.current = { kind: "deal", key: deal };
    else if ((view && view !== "chat") || q.get("mode")) pendingLinkRef.current = { kind: "view", view: view ?? "trips", mode: q.get("mode") };
    const from = q.get("from")?.split(",");
    if (from && from.length >= 2 && Number.isFinite(Number(from[0])) && Number.isFinite(Number(from[1]))) {
      setOrigin({ lat: Number(from[0]), lon: Number(from[1]), label: from.slice(2).join(",") || "shared location", source: "search" });
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
  const gateways = useMemo<Gateway[]>(() => (origin ? nearestGateways(airports, origin.lat, origin.lon) : []), [airports, origin]);
  // The airports a search flies from: the nearest real one, plus up to two bigger ones within 250 km.
  // Airfields with a handful of flights a week only count when nothing bigger is within reach.
  const homeAirports = useMemo(() => {
    if (!gateways.length) return [] as { iata: string; label: string }[];
    const sizeRank = (a: Airport) => (a.size === "large" ? 0 : a.size === "medium" ? 1 : 2);
    const near = gateways.filter((g) => g.km <= 250);
    const real = near.filter((g) => g.airport.size !== "small");
    const first = real[0] ?? near[0] ?? gateways[0];
    const rest = (real.length ? real : near)
      .filter((g) => g !== first)
      .sort((a, b) => sizeRank(a.airport) - sizeRank(b.airport) || a.km - b.km)
      .slice(0, 2);
    return [first, ...rest].map((g) => ({ iata: g.airport.iata, label: g.airport.city ?? g.airport.name }));
  }, [gateways]);
  const homeCity = useMemo<{ code: string; city: City } | null>(() => {
    if (!origin) return null;
    let best: { code: string; city: City } | null = null;
    let bestKm = 30;
    for (const [code, c] of Object.entries(cities)) {
      if (Math.abs(c.lat - origin.lat) > 0.5) continue;
      const km = haversineKm(origin.lat, origin.lon, c.lat, c.lon);
      if (km < bestKm) {
        bestKm = km;
        best = { code, city: c };
      }
    }
    return best;
  }, [origin, cities]);
  const originPlace = useMemo<ItinPlace | undefined>(() => (origin ? { name: homeCity?.city.name ?? origin.label, ...(homeCity ? { code: homeCity.code, country: homeCity.city.country } : {}), lat: origin.lat, lon: origin.lon } : undefined), [origin, homeCity]);
  /** The query's From: the traveller's place and airports. Null until the airports are known. */
  const searchFrom = useMemo<SearchQuery["from"] | null>(() => {
    if (!origin || !homeAirports.length || !gateways[0]) return null;
    return { label: homeCity?.city.name ?? origin.label, lat: origin.lat, lon: origin.lon, airports: homeAirports.map((g) => g.iata), home: gateways[0].airport.country };
  }, [origin, homeAirports, gateways, homeCity]);
  const searchFromRef = useRef(searchFrom);
  searchFromRef.current = searchFrom;
  const homeLabel = homeAirports[0]?.label ?? origin?.label ?? "Home";

  // ---- Coordinates for codes and names: an airport by IATA, a city by its code, a city by name.
  const coordOf = useCallback(
    (code: string): [number, number] | null => {
      const a = byIata.get(code);
      if (a) return [a.lon, a.lat];
      const c = cities[code];
      return c ? [c.lon, c.lat] : null;
    },
    [cities, byIata],
  );
  /** Where a code is, for the converters of lib/trip-result.ts: an airport, else a city. */
  const locate = useCallback<Locate>(
    (code) => {
      const a = byIata.get(code);
      if (a) return { name: a.city ?? a.name, country: a.country, lat: a.lat, lon: a.lon };
      const c = cities[code];
      return c ? { name: c.name, country: c.country, lat: c.lat, lon: c.lon } : null;
    },
    [byIata, cities],
  );
  const locateRef = useRef(locate);
  locateRef.current = locate;
  /** Cities by folded name, the most populous of a name first: "Krakow" and "Kraków" find the same one. */
  const cityByFold = useMemo(() => {
    const m = new Map<string, City & { code: string }>();
    for (const [code, c] of Object.entries(cities)) {
      const k = foldName(c.name);
      const cur = m.get(k);
      if (!cur || (c.pop ?? 0) > (cur.pop ?? 0)) m.set(k, { ...c, code });
    }
    return m;
  }, [cities]);
  /**
   * A named place in the city table: the exact name (the traveller's country first, then their
   * part of the world), a code in capitals ("GDN"), a leading word ("Cluj" finds Cluj-Napoca).
   */
  function cityByName(name: string): (City & { code: string }) | null {
    const raw = name.trim();
    const q = foldName(raw);
    if (!q) return null;
    const list = Object.entries(cities);
    const o = originRef.current ?? origin;
    const homeCountry = gateways[0]?.airport.country;
    const weight = (c: City) => {
      let w = 0;
      for (const a of c.airports) w = Math.max(w, byIata.get(a)?.size === "large" ? 30 : byIata.get(a)?.size === "medium" ? 10 : 0);
      if (homeCountry && c.country === homeCountry) w += 1000;
      else if (o && haversineKm(o.lat, o.lon, c.lat, c.lon) < 3500) w += 300;
      return w;
    };
    const pickBest = (hits: [string, City][]) => (hits.length ? hits.reduce((b, x) => (weight(x[1]) > weight(b[1]) ? x : b)) : null);
    const out = (hit: [string, City] | null | undefined) => (hit ? { ...hit[1], code: hit[0] } : null);
    const exact = pickBest(list.filter(([, c]) => foldName(c.name) === q));
    if (exact) return out(exact);
    if (/^[A-Z]{3}$/.test(raw)) {
      if (cities[raw]) return { ...cities[raw], code: raw };
      const byAirport = list.find(([, c]) => c.airports.includes(raw));
      if (byAirport) return out(byAirport);
    }
    if (q.length >= 4) {
      const leading = pickBest(list.filter(([, c]) => {
        const n = foldName(c.name);
        return n.startsWith(q) && !/[a-z0-9]/.test(n.charAt(q.length));
      }));
      if (leading) return out(leading);
    }
    return null;
  }
  /** A country word or code to ISO2: "Poland", "pl", "PL". */
  function countryCode(word: string): string | null {
    const w = word.trim();
    if (/^[A-Za-z]{2}$/.test(w) && countries[w.toUpperCase()]) return w.toUpperCase();
    const f = foldName(w);
    for (const [code, c] of Object.entries(countries)) if (foldName(c.name) === f || foldName(countryName(code)) === f) return code;
    return null;
  }
  /** Where a typed word sends the search: anywhere, a region, a country or a place. Loops and long stays read a region word first ("turkey" is the Caucasus and Turkey region there). */
  function resolveTo(word: string | undefined, regionFirst = false): SearchQuery["to"] {
    const w = word?.trim();
    if (!w || /^(any ?where|every ?where|anyplace)$/i.test(w)) return { kind: "anywhere" };
    const rk = regionKey(w);
    if (rk && regionFirst) return { kind: "region", key: rk };
    const cc = countryCode(w);
    if (cc) return { kind: "country", name: countries[cc]?.name ?? countryName(cc), code: cc };
    if (rk) return { kind: "region", key: rk };
    return { kind: "place", name: w };
  }
  /** A named start as the query's From: the city and its airports within 250 km. */
  function fromNamed(name: string | undefined): SearchQuery["from"] | null {
    const base = searchFromRef.current;
    if (!name || !name.trim() || (base && foldName(name) === foldName(base.label))) return base;
    const c = cityByName(name);
    if (!c) {
      setNotice(`${name} is not on the map; the search starts from where you are.`);
      return base;
    }
    const near = nearestGateways(airports, c.lat, c.lon).filter((g) => g.km <= 250);
    const real = near.filter((g) => g.airport.size !== "small");
    const ids = (real.length ? real : near).slice(0, 3).map((g) => g.airport.iata);
    if (!ids.length) return base;
    return { label: c.name, lat: c.lat, lon: c.lon, airports: ids, home: c.country };
  }

  // ---- Running a search from outside the bar. The Search tab comes to the front, whatever
  // was in front of it closes, and the tab gets the query (auto: run it; else fill the bar).
  const runSearch = useCallback((q: SearchQuery, auto = true) => {
    setPlacePage(null);
    setOpenTrip(null);
    setItin(null);
    setItinShape(null);
    setTab("search");
    setSearchRun({ query: q, n: Date.now(), auto });
    if (isPhone() && sheetRef.current === "peek") setSheet("half");
  }, []);
  const runSearchRef = useRef(runSearch);
  runSearchRef.current = runSearch;
  /** The trip style and Been as every query from outside the bar carries them. */
  function withTraveller(q: Omit<SearchQuery, "from"> & { from?: SearchQuery["from"] | null }, over?: Partial<Prefs>): SearchQuery | null {
    const from = q.from ?? searchFromRef.current;
    if (!from) return null;
    const p: Prefs = { ...prefs, ...(over ?? {}) };
    const skip = [...new Set([...exclude, ...avoidCodes(p), ...(q.exclude ?? [])])];
    return { ...q, from, prefs: p, ...(skip.length ? { exclude: skip } : {}) };
  }
  // The Search tab reports every search it starts (the bar's own, or one handed to it).
  function onQuery(q: SearchQuery) {
    setLastQuery(q);
    lastQueryRef.current = q;
    setSaved(rememberSearch(q));
    setOpenTrip(null);
    setHoverId(null);
    frameNextRef.current = true;
    seenIdsRef.current = new Set();
    // A walk left on the globe from an earlier question gives the stage to this one.
    if (walk.status !== "loading") setWalk(EMPTY_WALK);
  }
  function onResults(list: TripResult[], status: SearchStatus) {
    setResults(list);
    setSearchStatus(status);
    // A shared link's trip opens as soon as its search lists it; a finished search without it drops the wish.
    const want = pendingTripRef.current;
    if (want) {
      const hit = list.find((t) => t.id === want);
      if (hit) {
        pendingTripRef.current = null;
        openTripPage(hit, lastQueryRef.current);
      } else if (status.status === "ok" || status.status === "error") {
        pendingTripRef.current = null;
        setNotice("That trip is no longer in the results; here is the search it came from.");
      }
    }
    // A trip that just arrived draws its arc from home, growing in and fading, while its tag pops in.
    const now = performance.now();
    let k = 0;
    for (const t of list.slice(0, 60)) {
      if (seenIdsRef.current.has(t.id)) continue;
      seenIdsRef.current.add(t.id);
      const g = resultHome(t);
      const p = resultPoint(t);
      if (g && p && k < 40) arrivalsRef.current.push({ path: greatCircle(g, p, 40), at: now + k++ * 70, color: priceColor(t.price) });
    }
    if (arrivalsRef.current.length > 120) arrivalsRef.current.splice(0, arrivalsRef.current.length - 120);
    // The finished answer frames the camera once: the results and the traveller's door.
    if (frameNextRef.current && (status.status === "ok" || status.status === "error") && list.length) {
      frameNextRef.current = false;
      const pts = list.slice(0, 40).map(resultPoint).filter((x): x is [number, number] => !!x);
      if (origin) pts.push([origin.lon, origin.lat]);
      if (tabRef.current === "search" && !itin) framePoints(pts, 5);
    }
  }

  // ---- A result's geometry: its legs and stops placed through their own coordinates, else
  // their codes, else their names; a leg whose end is unknown continues from the last known
  // point so the line never breaks.
  const tripGeo = useCallback(
    (t: TripResult): { legs: RouteLeg[]; stops: WildStop[]; home: [number, number] | null } => {
      const byCode = new Map<string, [number, number]>();
      const byName = new Map<string, [number, number]>();
      for (const st of t.stops) {
        if (!placed(st.lat, st.lon)) continue;
        if (st.code) byCode.set(st.code, [st.lon, st.lat]);
        byName.set(foldName(st.name), [st.lon, st.lat]);
      }
      const at = (code: string, name: string, lat?: number, lon?: number): [number, number] | null => {
        if (placed(lat, lon)) return [lon!, lat!];
        const named = cityByFold.get(foldName(name));
        return byCode.get(code) ?? coordOf(code) ?? byName.get(foldName(name)) ?? (named ? [named.lon, named.lat] : null);
      };
      const legs: RouteLeg[] = [];
      let last: [number, number] | null = null;
      let home: [number, number] | null = null;
      t.legs.forEach((l, i) => {
        const from = at(l.from, l.fromName, l.fromLat, l.fromLon) ?? last;
        const to = at(l.to, l.toName, l.toLat, l.toLon);
        if (i === 0) home = from;
        if (from && to) {
          legs.push({ from, to, kind: l.kind === "fly" ? "fly" : "ground" });
          last = to;
        }
      });
      const stops: WildStop[] = [];
      for (const st of t.stops) {
        const c = placed(st.lat, st.lon) ? ([st.lon, st.lat] as [number, number]) : at(st.code ?? "", st.name);
        if (c) stops.push({ code: st.code ?? st.name, name: st.name, country: st.country, lat: c[1], lon: c[0], arrive: st.arrive, depart: st.leave, nights: st.nights, perDay: 0 });
      }
      return { legs, stops, home: home ?? (origin ? [origin.lon, origin.lat] : null) };
    },
    [cityByFold, coordOf, origin],
  );
  /** Where a result's tag stands: the stop with the most nights (the first on a tie), else where the way out lands. */
  function resultPoint(t: TripResult): [number, number] | null {
    const main = [...t.stops].sort((a, b) => b.nights - a.nights)[0];
    if (main && placed(main.lat, main.lon)) return [main.lon, main.lat];
    const g = tripGeo(t);
    if (g.stops[0]) return [g.stops[0].lon, g.stops[0].lat];
    return g.legs[0]?.to ?? null;
  }
  function resultHome(t: TripResult): [number, number] | null {
    return tripGeo(t).home;
  }

  // ---- The chat's deals as results, so the globe and the trip page treat them like any other.
  const chatResults = useMemo<TripResult[]>(() => chatDeals.map((d) => tripFromDeal(d, { locate, source: "live", engine: "chat" })), [chatDeals, locate]);
  // What the globe shows as tags: the chat's own answer on the Ask tab, the search's list otherwise.
  const shownResults = tab === "chat" && chatResults.length ? chatResults : tab === "search" ? results : [];
  const resultDots = useMemo<ResultDot[]>(() => {
    const out: ResultDot[] = [];
    for (const t of shownResults.slice(0, 60)) {
      const p = resultPoint(t);
      if (p) out.push({ t, p });
    }
    return out;
    // resultPoint only reads tripGeo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownResults, tripGeo]);

  // ---- The itinerary view in front of the panel.
  const itinShowing = !!itin && !!itinShape;
  const placeCoord = useCallback((pl: ItinPlace): [number, number] | null => (placed(pl.lat, pl.lon) ? [pl.lon, pl.lat] : pl.code ? coordOf(pl.code) : null), [coordOf]);
  const itinRoute = useMemo<{ stops: WildStop[]; legs: RouteLeg[]; home: [number, number] | null } | null>(() => {
    if (!itinShowing || !itinShape) return null;
    const stops: WildStop[] = [];
    for (const st of itinShape.stops) {
      const c = placeCoord(st);
      if (c) stops.push({ code: st.code ?? st.name, name: st.name, country: st.country ?? "", lat: c[1], lon: c[0], arrive: st.arrive, depart: st.leave, nights: st.nights, perDay: 0 });
    }
    const legs: RouteLeg[] = [];
    for (const l of itinShape.legs as ItinLeg[]) {
      const from = placeCoord(l.from);
      const to = placeCoord(l.to);
      if (from && to) legs.push({ from, to, kind: l.kind === "fly" ? "fly" : "ground" });
    }
    return { stops, legs, home: itinShape.origin ? placeCoord(itinShape.origin) : null };
  }, [itinShowing, itinShape, placeCoord]);

  // ---- The walk on the globe: drawn while it runs and while its best loop is the answer on show.
  // A walk belongs to the tab that asked for it (the chat, mostly): another tab does not keep it bold, and on the
  // Search tab a hovered card outranks it.
  const walkShowing = walk.status !== "idle" && !itinShowing && !openTrip && walkTab === tab && !(tab === "search" && hoverId);
  /** The point the walk's HOME node stands for. */
  function walkHome(q: WalkQuery | undefined): [number, number] | null {
    if (q?.lat == null || q.lon == null) return null;
    const lat = Number(q.lat);
    const lon = Number(q.lon);
    return Number.isFinite(lat) && Number.isFinite(lon) ? [lon, lat] : null;
  }
  const walkLoop = walkShowing ? (walk.loops[walk.selected] ?? null) : null;
  const walkRoute = useMemo<{ stops: WildStop[]; legs: RouteLeg[]; home: [number, number] | null } | null>(() => {
    if (!walkLoop) return null;
    const home = walkHome(walk.params);
    const byCode = new Map(walkLoop.stops.map((st) => [st.code, [st.lon, st.lat] as [number, number]]));
    const at = (code: string) => (code === "HOME" ? home : (byCode.get(code) ?? coordOf(code)));
    const legs: RouteLeg[] = [];
    for (const l of walkLoop.legs) {
      const a = at(l.from);
      const b = at(l.to);
      if (a && b) legs.push({ from: a, to: b, kind: l.kind === "fly" ? "fly" : "ground" });
    }
    const stops: WildStop[] = walkLoop.stops.map((st) => ({ code: st.code, name: st.name, country: st.country, lat: st.lat, lon: st.lon, arrive: st.arrive, depart: st.leave, nights: st.nights, perDay: 0 }));
    return { stops, legs, home };
    // walkHome only reads its argument.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walkLoop, walk.params, coordOf]);

  // ---- The one route the globe draws bold: the itinerary in front, else a walk's best loop,
  // else the open trip page, else the trip hovered (on a card or a tag), else the chat's loop.
  const hoverTrip = hoverId ? (shownResults.find((t) => t.id === hoverId) ?? null) : null;
  const chatRoute = useMemo<{ stops: WildStop[]; legs: RouteLeg[]; home: [number, number] | null } | null>(() => {
    if (!chatTrip || tab !== "chat" || chatDeals.length) return null;
    const legs: RouteLeg[] = [];
    for (const l of chatTrip.legs) {
      const a = coordOf(l.from);
      const b = coordOf(l.to);
      if (a && b) legs.push({ from: a, to: b, kind: l.kind === "fly" ? "fly" : "ground" });
    }
    return { stops: chatTrip.stops, legs, home: coordOf(chatTrip.home) };
  }, [chatTrip, tab, chatDeals.length, coordOf]);
  const route = useMemo(() => {
    if (itinRoute) return itinRoute;
    if (walkRoute) return walkRoute;
    const t = openTrip ?? hoverTrip;
    if (t) return tripGeo(t);
    return chatRoute;
  }, [itinRoute, walkRoute, openTrip, hoverTrip, tripGeo, chatRoute]);
  const routePoints = useMemo<[number, number][]>(() => {
    if (!route) return [];
    const pts: [number, number][] = [];
    for (const l of route.legs) {
      if (!pts.length) pts.push(l.from);
      pts.push(l.to);
    }
    return pts;
  }, [route]);

  // ---- The trip page.
  function frameTrip(t: TripResult) {
    const g = tripGeo(t);
    const pts: [number, number][] = g.stops.map((st) => [st.lon, st.lat]);
    if (g.home && g.stops.length < 6) pts.push(g.home);
    if (!pts.length) for (const l of g.legs) pts.push(l.from, l.to);
    framePoints(pts, 6);
  }
  /** Where a trip's plan starts: the From of the query behind it ("loop from Cluj" starts in Cluj), else home. */
  function tripOrigin(q: SearchQuery | null): ItinPlace | undefined {
    const f = q?.from;
    if (!f || !placed(f.lat, f.lon)) return originPlace;
    if (origin && Math.abs(f.lat - origin.lat) < 0.01 && Math.abs(f.lon - origin.lon) < 0.01) return originPlace;
    const c = cityByName(f.label);
    return { name: f.label, ...(c ? { code: c.code, country: c.country } : {}), lat: f.lat, lon: f.lon };
  }
  function openTripPage(t: TripResult, q?: SearchQuery | null) {
    stopPlay();
    setItin(null);
    setItinShape(null);
    setPlacePage(null);
    setOpenTrip(t);
    const from = searchFromRef.current;
    setOpenTripQuery(q ?? (from ? { from, to: { kind: "anywhere" }, when: { kind: "anytime" } } : null));
    frameNextRef.current = false;
    if (isPhone() && sheetRef.current !== "half") {
      sheetRef.current = "half";
      setSheet("half");
    }
    frameTrip(t);
  }
  const openTripRef = useRef(openTripPage);
  openTripRef.current = openTripPage;

  // ---- The chat. Its answer is stored at once; moving the camera waits until the Ask tab is in front.
  function onChatDeals(ds: Deal[]) {
    setChatTrip(null);
    setChatDeals(ds);
    if (tabRef.current !== "chat") return;
    const pts = ds.map((d) => coordOf(d.dstCity) ?? coordOf(d.dst)).filter((c): c is [number, number] => !!c);
    if (origin) pts.push([origin.lon, origin.lat]);
    framePoints(pts, 5, 1400);
  }
  function onChatTrip(t: WildTrip) {
    setChatDeals([]);
    setChatTrip(t);
    if (tabRef.current !== "chat") return;
    const pts = t.stops.filter((s) => placed(s.lat, s.lon)).map((s) => [s.lon, s.lat] as [number, number]);
    framePoints(pts, 5);
  }
  function onChatOpenDeal(key: string) {
    const parts = key.split("|");
    const d = chatDeals.find((x) => [x.gw, x.dst, x.out, x.back].join("|") === parts.slice(0, 4).join("|")) ?? chatDeals.find((x) => x.gw === parts[0] && x.dst === parts[1] && x.out === parts[2]);
    if (d) openTripPage(tripFromDeal(d, { locate, source: "live", engine: "chat" }));
  }

  // ---- Place pages from anywhere: atlas:place {name?, code?}, the command line.
  function openPlace(q: { name?: string; code?: string }) {
    const code = q.code?.trim().toUpperCase();
    let hit: { code?: string; name: string; country?: string; lat: number; lon: number } | null = null;
    if (code && cities[code]) hit = { code, ...cities[code] };
    if (!hit && q.name) {
      const c = cityByName(q.name);
      if (c) hit = c;
    }
    if (!hit) {
      const a = code ? byIata.get(code) : q.name ? airports.find((x) => foldName(x.city ?? "") === foldName(q.name!)) : undefined;
      if (a) hit = { name: a.city ?? a.name, country: a.country, lat: a.lat, lon: a.lon };
    }
    if (!hit) {
      setNotice(`No place called "${q.name ?? q.code}" on the map yet. Try the nearest city.`);
      return;
    }
    setItin(null);
    setItinShape(null);
    setPlacePage({ name: hit.name, code: hit.code, country: hit.country, lat: hit.lat, lon: hit.lon });
    setSightsOnMap(false);
    if (isPhone() && sheetRef.current === "peek") setSheet("half");
    spinRef.current = false;
    revealMap();
    mapRef.current?.flyTo({ center: [hit.lon, hit.lat], zoom: 5.5, duration: 1500, padding: panelPadding() });
  }
  const openPlaceRef = useRef(openPlace);
  openPlaceRef.current = openPlace;
  // What a place page knows: the facts from the static files, the summary, sights, food and what is on.
  const intel = useMemo<Intel | null>(() => {
    if (!placePage) return null;
    const code = placePage.code;
    const city = code ? cities[code] : undefined;
    const countryCode = placePage.country ?? city?.country;
    const horizon = localIso(new Date(Date.now() + 60 * 86_400_000));
    const today = todayIso();
    const passport = gateways[0]?.airport.country;
    return {
      code,
      tz: city?.tz,
      lat: placePage.lat,
      lon: placePage.lon,
      countryCode,
      country: countryCode ? countries[countryCode] : undefined,
      weather: code ? weather?.cities[code] : undefined,
      sea: code ? weather?.sea[code] : undefined,
      holidays: countryCode ? (holidays[countryCode] ?? []).filter((h) => h.date >= today && h.date <= horizon).slice(0, 2) : undefined,
      places: code ? cityPlaces[code] : undefined,
      pop: city?.pop,
      fame: code ? fame?.[code] : undefined,
      visa: visa && countryCode && passport && passport !== countryCode ? { passport, text: visaFor(visa, passport, countryCode), updated: visa.updated } : undefined,
      heritage: heritage
        .filter((h) => Math.abs(h[1] - placePage.lat) < 0.8)
        .map((h) => ({ name: h[0], km: Math.round(haversineKm(placePage.lat, placePage.lon, h[1], h[2])) }))
        .filter((h) => h.km <= 60)
        .sort((a, b) => a.km - b.km)
        .slice(0, 3),
      events,
    };
  }, [placePage, cities, countries, weather, holidays, cityPlaces, heritage, visa, gateways, events, fame]);
  useEffect(() => {
    setEvents([]);
    setSummary(null);
    setSights(null);
    setEats(null);
    setSightsOnMap(false);
    if (!placePage) return;
    const ctrl = new AbortController();
    const get = <T,>(url: string, set: (v: T | null) => void) =>
      fetch(url, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: T | null) => set(j))
        .catch(() => {});
    const { lat, lon, name } = placePage;
    get<{ status: string; events?: typeof events }>(`/api/events?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&days=30`, (j) => setEvents(j?.status === "ok" ? (j.events ?? []) : []));
    get<PlaceSummary>(`/api/place?name=${encodeURIComponent(name)}`, setSummary);
    get<Sights>(`/api/sights?name=${encodeURIComponent(name)}`, setSights);
    get<EatsResponse>(`/api/eats?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, setEats);
    return () => ctrl.abort();
  }, [placePage]);
  function showSights() {
    if (!placePage) return;
    setSightsOnMap(true);
    revealMap();
    mapRef.current?.flyTo({ center: [placePage.lon, placePage.lat], zoom: 12.2, duration: 1800, padding: panelPadding() });
  }

  // ---- Itineraries: every result can become one; the view sits in front of the panel.
  function frameShape(sh: Skeleton | Itin) {
    const pts = sh.stops.map(placeCoord).filter((c): c is [number, number] => !!c);
    const home = placeCoord(sh.origin);
    if (home && pts.length && sh.stops.length < 6) pts.push(home);
    framePoints(pts, 6);
  }
  function openItinerary(o0: Omit<ItinOpen, "n">) {
    const o = o0.skeleton && !o0.itinerary ? { ...o0, skeleton: firstWeeks(o0.skeleton) } : o0;
    const sh = o.itinerary ?? o.skeleton;
    if (!sh) return;
    stopPlay();
    setItin({ ...o, n: Date.now() });
    setItinShape(sh);
    if (isPhone()) setSheet("half");
    frameShape(sh);
  }
  function closeItinerary() {
    stopPlay();
    setItin(null);
    setItinShape(null);
  }
  const openItineraryRef = useRef(openItinerary);
  openItineraryRef.current = openItinerary;
  /** A few nights at a place page's city, two weeks out. */
  function placeSkeleton(pl: { name: string; code?: string; country?: string; lat: number; lon: number }, nights = 3): Skeleton | null {
    if (!originPlace) return null;
    const start = localIso(new Date(Date.now() + 14 * 86_400_000));
    const here: ItinPlace = { name: pl.name, ...(pl.code ? { code: pl.code } : {}), ...(pl.country ? { country: pl.country } : {}), lat: pl.lat, lon: pl.lon };
    return chainSkeleton(originPlace, [{ pl: here, nights }], start);
  }
  /** "itinerary Lisbon 3 nights, Porto 2 nights from 14 Nov": the stops placed through the city table, legs unpriced. */
  function customSkeleton(stops: { place: string; nights: number }[], start?: string, from?: string): Skeleton | null {
    const find = (name: string): ItinPlace | null => {
      const c = cityByFold.get(foldName(name));
      return c ? { name: c.name, code: c.code, country: c.country, lat: c.lat, lon: c.lon } : null;
    };
    const home = (from ? find(from) : null) ?? originPlace;
    if (!home) return null;
    const found = stops.map((st) => ({ pl: find(st.place), nights: st.nights })).filter((x): x is { pl: ItinPlace; nights: number } => !!x.pl);
    return chainSkeleton(home, found, start && ISO_DAY.test(start) ? start : localIso(new Date(Date.now() + 14 * 86_400_000)));
  }
  /** Placed stops in order from home and back, legs unpriced: a flight past 600 km, else a train. */
  function chainSkeleton(home: ItinPlace, stops: { pl: ItinPlace; nights: number }[], start: string): Skeleton | null {
    let day = start;
    const placedStops: Skeleton["stops"] = [];
    for (const st of stops) {
      const leave = addDays(day, Math.max(1, st.nights));
      placedStops.push({ ...st.pl, arrive: day, leave, nights: Math.max(1, st.nights) });
      day = leave;
    }
    if (!placedStops.length) return null;
    const chain: ItinPlace[] = [home, ...placedStops, home];
    const legs: ItinLeg[] = chain.slice(1).map((to, i) => {
      const from = chain[i];
      const km = haversineKm(from.lat, from.lon, to.lat, to.lon);
      return { kind: km > 600 ? "fly" : "train", from, to, date: i === 0 ? placedStops[0].arrive : placedStops[Math.min(i, placedStops.length) - 1].leave, price: null, note: "not priced yet" };
    });
    const nights = placedStops.reduce((t, x) => t + x.nights, 0);
    return { title: placedStops.map((x) => x.name).join(", "), subtitle: `${nights} nights from ${home.name}`, origin: home, start: placedStops[0].arrive, end: placedStops[placedStops.length - 1].leave, nights, stops: placedStops, legs, source: "custom" };
  }
  /** The skeleton of what is on show, for "/itinerary": the place page, the trip page, the chat's loop. */
  function shownSkeleton(): Skeleton | null {
    if (placePage) return placeSkeleton(placePage);
    if (openTrip) return skeletonFromTripResult(openTrip, originPlace);
    if (tab === "chat" && chatTrip) return skeletonFromWild(chatTrip);
    return null;
  }

  // ---- The graph walk drawn on the globe.
  /** Where the traveller is and flies from, the part of every walk the asker does not have to say. */
  function walkContext(): WalkQuery | null {
    const o = originRef.current ?? origin;
    if (!o || !homeAirports.length || !gateways[0]) return null;
    const label = (homeCity?.city.name ?? o.label).replace(/[^\p{L}\p{N} ,.'()&-]/gu, " ").trim().slice(0, 60) || "home";
    return { g: homeAirports.map((g) => g.iata).slice(0, 4), home: gateways[0].airport.country, lat: o.lat.toFixed(3), lon: o.lon.toFixed(3), label, ...(exclude.length ? { exclude: exclude.join(",") } : {}) };
  }
  /** The edges of finished loops, for an answer that came without its stream: the best loop's legs chosen, the rest faint. */
  function edgesOfLoops(loops: WalkLoop[], q: WalkQuery | undefined): WalkEdgeView[] {
    const home = walkHome(q);
    const out: WalkEdgeView[] = [];
    const long = performance.now() - 60_000;
    loops.forEach((loop, k) => {
      const byCode = new Map(loop.stops.map((st) => [st.code, [st.lon, st.lat] as [number, number]]));
      const at = (code: string) => (code === "HOME" ? home : (byCode.get(code) ?? coordOf(code)));
      for (const l of loop.legs) {
        if (l.kind === "road") continue;
        const a = at(l.from);
        const b = at(l.to);
        if (!a || !b) continue;
        out.push({ from: l.from, to: l.to, toName: l.toName, lat: b[1], lon: b[0], kind: l.kind, price: l.price, minutes: l.minutes, source: l.source, chosen: k === 0, home: l.to === "HOME", path: l.kind === "fly" ? greatCircle(a, b, 40) : straightPath(a, b), at: long });
      }
    });
    return out;
  }
  function frameWalkLoop(loop: WalkLoop | undefined, q: WalkQuery | undefined) {
    if (!loop) return;
    const pts: [number, number][] = loop.stops.map((st) => [st.lon, st.lat]);
    const h = walkHome(q);
    if (h) pts.push(h);
    framePoints(pts, 5.5, 1600);
  }
  /** The walk takes the stage: the walk state starts over for this question, and the camera comes to the door. */
  function startWalkStage(q: WalkQuery): { home: [number, number] | null; toHome: number } {
    walkNodesRef.current = new Map();
    const home = walkHome(q);
    if (home) walkNodesRef.current.set("HOME", { p: home, money: 0 });
    setWalk({ ...EMPTY_WALK, status: "loading", params: q, source: "event", open: true });
    setWalkClock(performance.now());
    const map = mapRef.current;
    let toHome = 0;
    if (map && home) {
      spinRef.current = false;
      toHome = window.setTimeout(() => map.flyTo({ center: home, zoom: isPhone() ? 2.4 : 3.3, duration: reducedMotion() ? 0 : 1400, padding: panelPadding(), essential: true }), 60);
    }
    return { home, toHome };
  }
  /** Draws one streamed line of a walk (its progress, a node, an edge, a loop) into the walk state. */
  function walkLineDrawer(home: [number, number] | null, stale: () => boolean) {
    return (msg: WalkLine) => {
      if (stale()) return;
      const now = performance.now();
      if (msg.progress) setWalk((w) => ({ ...w, lines: [...w.lines, msg.progress!].slice(-40) }));
      if (msg.node) {
        const n = msg.node;
        const prev = walkNodesRef.current.get(n.code);
        walkNodesRef.current.set(n.code, { p: [n.lon, n.lat], money: prev?.money });
        setWalk((w) => ({ ...w, nodes: [...w.nodes.filter((x) => x.code !== n.code), { ...n, money: prev?.money, at: now }] }));
      }
      if (msg.edge) {
        const e = msg.edge;
        const a = walkNodesRef.current.get(e.from)?.p ?? (e.from === "HOME" ? home : coordOf(e.from));
        const b: [number, number] = [e.lon, e.lat];
        if (a && placed(e.lat, e.lon)) {
          // The money so far at a city: what its chosen way in cost on top of the money at the city it came from.
          let money: number | undefined;
          if (e.chosen && !e.home) {
            money = Math.round((walkNodesRef.current.get(e.from)?.money ?? 0) + e.price);
            const cur = walkNodesRef.current.get(e.to);
            walkNodesRef.current.set(e.to, { p: cur?.p ?? b, money });
          }
          const view: WalkEdgeView = { ...e, path: e.kind === "fly" ? greatCircle(a, b, 40) : straightPath(a, b), at: now };
          setWalk((w) => {
            let edges = w.edges;
            const same = (x: WalkEdgeView) => x.from === e.from && x.to === e.to && x.kind === e.kind;
            if (e.chosen && edges.some(same)) edges = edges.map((x) => (same(x) ? { ...x, chosen: true, at: now } : x));
            else edges = [...edges, view];
            // Bounded: the oldest edges that were never chosen leave first.
            if (edges.length > WALK_MAX_EDGES) {
              let drop = edges.length - WALK_MAX_EDGES;
              edges = edges.filter((x) => {
                if (drop > 0 && !x.chosen) {
                  drop--;
                  return false;
                }
                return true;
              });
            }
            const nodes = money != null ? w.nodes.map((x) => (x.code === e.to ? { ...x, money } : x)) : w.nodes;
            return { ...w, edges, nodes };
          });
        }
      }
      if (msg.loop) {
        const loop = "loop" in msg.loop ? msg.loop.loop : msg.loop;
        setWalk((w) => {
          const loops = [...w.loops.filter((x) => x.id !== loop.id && x.title !== loop.title), loop].sort((x, y) => x.score - y.score).slice(0, 6);
          return { ...w, loops, selected: 0 };
        });
      }
    };
  }
  /**
   * Runs a walk and draws it live (the chat's 'atlas:walk', a restored thread drawn again at
   * zero searches). What the asker left out comes from where the traveller is; a newer walk
   * stops the older one, so it spends no more live searches.
   */
  async function runWalk(given: WalkQuery) {
    const ctx = walkContext();
    const q: WalkQuery = { ...(ctx ?? {}) };
    for (const k of WALK_PARAM_KEYS) {
      const v = given[k];
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
      q[k] = v;
    }
    if (!q.g || !q.home || q.lat == null || q.lon == null) {
      setNotice("Your airports are still loading; try again in a moment.");
      return;
    }
    if (!q.from || !q.to || !ISO_DAY.test(String(q.from)) || !ISO_DAY.test(String(q.to))) {
      const maxN = Number(q.maxNights ?? q.minNights ?? 6) || 6;
      const f = addDays(todayIso(), 1);
      q.from = f;
      q.to = addDays(f, Math.max(21, maxN + 4));
    }
    walkCtrl.current?.abort();
    walkLiveRef.current = null;
    const ctrl = new AbortController();
    walkCtrl.current = ctrl;
    const stale = () => walkCtrl.current !== ctrl;
    const { home, toHome } = startWalkStage(q);
    let finished = false;
    const drawLine = walkLineDrawer(home, stale);
    const onLine = (msg: WalkLine) => {
      if (stale()) return;
      drawLine(msg);
      if (msg.done) {
        finished = true;
        const r = msg.done;
        setWalk((w) => {
          const loops = r.loops.length ? r.loops : w.loops;
          return { ...w, status: "ok", result: r, loops, selected: 0, edges: w.edges.length ? w.edges : edgesOfLoops(loops, q) };
        });
        window.clearTimeout(toHome);
        frameWalkLoop(r.loops[0], q);
      }
      if (msg.error) {
        finished = true;
        setWalk((w) => ({ ...w, status: w.loops.length ? "ok" : "error", note: msg.error }));
      }
    };
    try {
      const r = await fetch(`/api/walk?${walkQueryString(q)}`, { signal: ctrl.signal });
      if (stale()) return;
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        if (!stale()) setWalk((w) => ({ ...w, status: "error", note: j.error ?? `the walk failed (${r.status})` }));
        return;
      }
      const ended = await readNdjson<WalkLine>(r, onLine, ctrl.signal);
      if (ended && !finished && !stale()) setWalk((w) => ({ ...w, status: w.loops.length ? "ok" : "error", note: w.loops.length ? undefined : "the walk stopped early; try again" }));
    } catch (err) {
      if ((err as Error | undefined)?.name === "AbortError" || stale()) return;
      setWalk((w) => ({ ...w, status: "error", note: "network" }));
    } finally {
      if (walkCtrl.current === ctrl) walkCtrl.current = null;
    }
  }
  /** A finished walk handed over (the chat): drawn without a search. */
  function showWalkResult(r: WalkResult, params?: WalkQuery) {
    walkCtrl.current?.abort();
    walkCtrl.current = null;
    walkLiveRef.current = null;
    const q: WalkQuery = { ...(walkContext() ?? {}), ...(params ?? {}) };
    setWalk({ ...EMPTY_WALK, status: "ok", params: q, source: "event", result: r, loops: r.loops, edges: edgesOfLoops(r.loops, q), open: true });
    frameWalkLoop(r.loops[0], q);
  }
  /**
   * A walk run elsewhere, drawn line by line ('atlas:walk-live' {id, params?, lines}): the
   * chat's walk_trips, or the search stream's loop search. A new id starts a new drawing at
   * params; the same id adds to it; 'atlas:walk-result' or a done line ends it.
   */
  function drawWalkLive(d: { id?: string; params?: WalkQuery; lines?: unknown[] }) {
    if (!d?.id || !Array.isArray(d.lines)) return;
    let cur = walkLiveRef.current;
    if (!cur || cur.id !== d.id) {
      walkCtrl.current?.abort();
      walkCtrl.current = null;
      const q: WalkQuery = { ...(walkContext() ?? {}), ...(d.params ?? {}) };
      const { home } = startWalkStage(q);
      const id = d.id;
      cur = { id, draw: walkLineDrawer(home, () => walkLiveRef.current?.id !== id) };
      walkLiveRef.current = cur;
    }
    for (const raw of d.lines) {
      const line = walkLineOf(raw as WalkEvent | WalkLine);
      cur.draw(line);
      if (line.done) {
        const r = line.done;
        setWalk((w) => ({ ...w, status: "ok", result: r, loops: r.loops.length ? r.loops : w.loops, selected: 0 }));
        walkLiveRef.current = null;
      }
    }
  }
  const runWalkRef = useRef(runWalk);
  runWalkRef.current = runWalk;
  const showWalkResultRef = useRef(showWalkResult);
  showWalkResultRef.current = showWalkResult;
  const drawWalkLiveRef = useRef(drawWalkLive);
  drawWalkLiveRef.current = drawWalkLive;
  // The tags that come and go need a clock while the stream runs, and one last tick after it ends to clear them.
  useEffect(() => {
    if (walk.status !== "loading") {
      const t = window.setTimeout(() => setWalkClock(performance.now()), EDGE_TAG_MS + 200);
      return () => window.clearTimeout(t);
    }
    const id = window.setInterval(() => setWalkClock(performance.now()), 600);
    return () => window.clearInterval(id);
  }, [walk.status]);
  // What the animation loop draws: the edges split by kind, the nodes while the walk runs, and the best loop's legs.
  useEffect(() => {
    if (!walkShowing || !walk.edges.length) {
      walkDrawRef.current = null;
      return;
    }
    const best = walk.loops[walk.selected];
    // Streamed edges run between city codes and HOME, a loop's legs between airports: both spellings are keyed.
    const bestKeys = new Set((best?.legs ?? []).map((l) => `${l.from}>${l.to}`));
    if (best?.stops.length) {
      const chain = ["HOME", ...best.stops.map((st) => st.code), "HOME"];
      for (let i = 1; i < chain.length; i++) bestKeys.add(`${chain[i - 1]}>${chain[i]}`);
    }
    walkDrawRef.current = { fly: walk.edges.filter((e) => e.kind === "fly"), ground: walk.edges.filter((e) => e.kind !== "fly"), nodes: walk.status === "loading" ? walk.nodes : [], done: walk.status !== "loading", best: bestKeys, v: (walkDrawRef.current?.v ?? 0) + 1 };
  }, [walkShowing, walk.edges, walk.nodes, walk.status, walk.loops, walk.selected]);

  // ---- The command line: every command becomes one search, except a place, a plan, the chat and the app's own pages.
  /** The dates a window of words means: a window of three days or less is a weekend, back on the Monday at the latest. */
  function commandWindow(from?: string, to?: string, days = 21): { from: string; to: string; short: boolean } {
    const tomorrow = addDays(todayIso(), 1);
    const f = from && ISO_DAY.test(from) && from >= tomorrow ? from : tomorrow;
    const short = !!to && daysBetween(f, to) <= 2;
    const t = to && ISO_DAY.test(to) && to > f ? (short ? addDays(to, 1) : to) : addDays(f, days);
    return { from: f, to: t, short };
  }
  /** The loop kinds (walk, wild, long stay) go through lib/command.ts toSearchQuery, so the UI and the CLI turn a
   * line into the same search; the shell then fixes what the engine would refuse or show empty. */
  function loopQuery(c: Command): SearchQuery | null {
    const here = searchFromRef.current;
    if (!here) return null;
    const q = toSearchQuery(c, {
      here,
      today: todayIso(),
      prefs,
      // fromNamed falls back to where the traveller is (with a note) when the start is not on the map.
      resolve: (name) => fromNamed(name),
      destination: (name) => resolveTo(name),
    });
    if (!q) return null;
    // A long stay needs a place to stay in: with none typed ("/stay 2 months") it goes to Southeast Asia, as the
    // old Long stay form did, instead of being refused by /api/search.
    if (q.shape === "long" && q.to.kind === "anywhere") q.to = { kind: "region", key: "sea" };
    // The cities chip must not fight the shape: a loop keeps only trips of three places or more, and two cities
    // already means two, so only "3 cities" on a loop stays a chip.
    if (q.filters?.cities && !(q.shape === "loop" && q.filters.cities === 3)) {
      const { cities: _c, ...rest } = q.filters;
      if (Object.keys(rest).length) q.filters = rest;
      else delete q.filters;
    }
    // A typed window that starts today or earlier starts tomorrow, as the other command kinds do.
    if (q.when.kind === "window") {
      const tomorrow = addDays(todayIso(), 1);
      if (q.when.from < tomorrow) q.when = { ...q.when, from: tomorrow, ...(q.when.include && q.when.include < tomorrow ? { include: undefined } : {}) };
      if (q.when.to <= q.when.from) q.when = { ...q.when, to: addDays(q.when.from, 7) };
    }
    // "not Germany" arrives as words; the trip style's avoid list holds country codes and group words only.
    const p = q.prefs;
    const over: Partial<Prefs> | undefined = p
      ? {
          ...p,
          avoid: [...new Set(p.avoid.map((a) => (prefs.avoid.includes(a) ? a : Object.hasOwn(AVOID_GROUPS, a.toLowerCase()) ? a.toLowerCase() : (countryCode(a.replace(/^like:/i, "")) ?? ""))).filter(Boolean))],
        }
      : undefined;
    const { prefs: _p, ...rest } = q;
    return withTraveller(rest, over);
  }
  function commandQuery(c: Command): SearchQuery | null {
    switch (c.kind) {
      case "walk":
      case "wild":
      case "longstay":
        return loopQuery(c);
      case "route": {
        const to = (c.to ?? "").trim();
        const depart = c.depart && ISO_DAY.test(c.depart) ? c.depart : undefined;
        const nights = c.nights && c.nights > 0 ? c.nights : undefined;
        const flex = c.flex != null && c.flex > 0 ? Math.min(3, c.flex) : 0;
        const when: SearchQuery["when"] = depart
          ? flex
            ? { kind: "window", from: addDays(depart, -flex), to: addDays(depart, flex + (c.oneWay ? 0 : (nights ?? 4))), include: depart }
            : { kind: "dates", out: depart, ...(c.oneWay ? {} : { back: addDays(depart, nights ?? 4) }) }
          : { kind: "anytime" };
        return withTraveller({ from: fromNamed(c.from), to: to ? resolveTo(to) : { kind: "anywhere" }, when, ...(nights && !c.oneWay ? { nights: [nights, nights] as [number, number] } : {}), ...(c.oneWay ? { oneWay: true } : {}), shape: c.oneWay ? "any" : "return" });
      }
      case "getaways": {
        const win = commandWindow(c.from, c.to);
        const span = Math.max(1, daysBetween(win.from, win.to));
        const maxNights = Math.max(1, Math.min(span, c.maxNights ?? (win.short ? 3 : 5)));
        const minNights = Math.max(1, Math.min(maxNights, c.minNights ?? (win.short ? 1 : 2)));
        return withTraveller({ to: resolveTo(c.where), when: { kind: "window", from: win.from, to: win.to }, nights: [minNights, maxNights], filters: { ...(c.maxHours ? { maxLegHours: c.maxHours } : {}), ...(c.maxPrice ? { maxPrice: c.maxPrice } : {}) } });
      }
      case "events": {
        // Events are a filter of the one search: what is on during the stay, as a badge and a chip.
        const win = commandWindow(c.from, c.to ?? (c.from ? addDays(c.from, 30) : undefined), 120);
        return withTraveller({ to: resolveTo(c.where), when: { kind: "window", from: win.from, to: win.to }, nights: [2, 7], filters: { eventsOn: true } });
      }
      default:
        return null;
    }
  }
  function runCommand(c: Command) {
    switch (c.kind) {
      case "place":
        openPlace({ name: c.name });
        return;
      case "itinerary": {
        const sk = c.stops?.length ? customSkeleton(c.stops, c.start, c.from) : shownSkeleton();
        if (sk) openItinerary({ skeleton: sk });
        else setNotice(c.stops?.length ? "None of those places is on the map; try the city names." : "Nothing on show to plan yet: open a trip or a place first, or type the stops (itinerary Lisbon 3 nights).");
        return;
      }
      case "ask":
        setPlacePage(null);
        setOpenTrip(null);
        if (itin) closeItinerary();
        setTab("chat");
        setChatSeed(c.text);
        return;
      // "my settings", "/trip-style", "how do i use this": the top bar opens the editor or the guide on these events.
      case "prefs":
        window.dispatchEvent(new CustomEvent("atlas:open-prefs"));
        return;
      case "help":
        window.dispatchEvent(new CustomEvent("atlas:guide"));
        return;
    }
    const q = commandQuery(c);
    if (q) runSearch(q);
    else setNotice("Your airports are still loading; try again in a moment.");
  }
  const runCommandRef = useRef(runCommand);
  runCommandRef.current = runCommand;

  // ---- Old links: Deals, Explore, the Trips modes and an open deal all become the one search.
  function oldLinkQuery(p: PendingLink): { q: SearchQuery | null; auto: boolean } {
    const tomorrow = addDays(todayIso(), 1);
    if (p.kind === "query") {
      const from = p.q.from ?? searchFromRef.current;
      return { q: from ? { ...p.q, from, prefs } : null, auto: true };
    }
    if (p.kind === "deal") {
      // A deal's key: home airport, destination, out, back (and the parts of a paired trip).
      const [, dst, out, back] = p.key.split("|");
      const c = dst ? (cities[dst] ?? cityByName(dst)) : null;
      const a = dst ? byIata.get(dst) : undefined;
      const name = c?.name ?? a?.city ?? dst ?? "";
      if (!name) return { q: null, auto: false };
      const dated = out && ISO_DAY.test(out) && out >= tomorrow;
      const when: SearchQuery["when"] = dated ? { kind: "dates", out, ...(back && ISO_DAY.test(back) ? { back } : {}) } : { kind: "window", from: tomorrow, to: addDays(tomorrow, 45) };
      const n = dated && back && ISO_DAY.test(back) ? daysBetween(out, back) : 0;
      return { q: withTraveller({ to: { kind: "place", name }, when, ...(n > 0 ? { nights: [n, n] as [number, number] } : { nights: [2, 7] as [number, number] }) }), auto: true };
    }
    const { view, mode } = p;
    const next45: SearchQuery["when"] = { kind: "window", from: tomorrow, to: addDays(tomorrow, 45) };
    if (view === "wild" || mode === "wild") return { q: withTraveller({ to: { kind: "region", key: "sea" }, when: { kind: "anytime" }, nights: [14, 14], shape: "loop", advanced: { wild: { region: "sea", nights: 14 } } }), auto: false };
    if (mode === "longstay") return { q: withTraveller({ to: { kind: "region", key: "sea" }, when: { kind: "anytime" }, shape: "long", advanced: { longStay: { months: 2 } } }), auto: false };
    if (mode === "group") return { q: withTraveller({ to: { kind: "anywhere" }, when: next45, nights: [2, 4], advanced: { group: { members: [] } } }), auto: false };
    if (mode === "purpose") return { q: withTraveller({ to: { kind: "anywhere" }, when: { kind: "window", from: tomorrow, to: addDays(tomorrow, 120) }, nights: [2, 7], filters: { eventsOn: true } }), auto: true };
    if (mode === "ab") return { q: withTraveller({ to: { kind: "anywhere" }, when: { kind: "anytime" } }), auto: false };
    if (view === "trips") return { q: withTraveller({ to: { kind: "anywhere" }, when: { kind: "window", from: tomorrow, to: addDays(tomorrow, 21) }, nights: [4, 7], shape: "loop" }), auto: true };
    if (view === "all" || view === "fly" || view === "ground" || view === "explore") return { q: withTraveller({ to: { kind: "anywhere" }, when: { kind: "anytime" }, nights: [2, 7] }), auto: true };
    // ?view=deals: the getaways of the next six weeks, two to seven nights, as the Deals tab listed them.
    return { q: withTraveller({ to: { kind: "anywhere" }, when: next45, nights: [2, 7] }), auto: true };
  }
  const citiesReady = Object.keys(cities).length > 0;
  useEffect(() => {
    const name = pendingPlaceRef.current;
    if (!name || !citiesReady) return;
    pendingPlaceRef.current = null;
    openPlaceRef.current(/^[A-Z]{3}$/.test(name) ? { code: name } : { name });
  }, [citiesReady]);
  useEffect(() => {
    const p = pendingLinkRef.current;
    if (!p || !searchFrom || !citiesReady) return;
    pendingLinkRef.current = null;
    const { q, auto } = oldLinkQuery(p);
    if (q) runSearch(q, auto);
    else setTab("search");
    // oldLinkQuery reads the state of now; it runs once, when the airports and the cities are known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchFrom, citiesReady]);

  // The address bar follows the app, so a search is a link: where from, the tab, the last query.
  useEffect(() => {
    if (!origin) return;
    const q = new URLSearchParams();
    q.set("from", `${origin.lat.toFixed(3)},${origin.lon.toFixed(3)},${origin.label}`);
    if (tab !== "search") q.set("tab", tab);
    if (lastQuery) {
      try {
        // The trip style and the airports belong to whoever opens the link, so they stay out of it.
        const { prefs: _p, ...rest } = lastQuery;
        q.set("q", searchQueryToParams(rest as SearchQuery));
      } catch {
        // A query the codec cannot write stays out of the address; the page still works.
      }
      // A trip page opened from this list is part of the link: the same search lists it again under the same id.
      if (openTrip && openTripQuery === lastQuery) q.set("trip", openTrip.id);
      else if (pendingTripRef.current) q.set("trip", pendingTripRef.current);
    }
    // A link not yet turned into a search keeps its words until it is.
    const now = new URLSearchParams(window.location.search);
    if (pendingLinkRef.current) for (const k of ["view", "mode", "deal", "q", "trip"]) if (now.get(k) && !q.get(k)) q.set(k, now.get(k)!);
    const url = `${window.location.pathname}?${q.toString()}`;
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", url);
  }, [origin, tab, lastQuery, openTrip, openTripQuery]);

  // ---- The window bus: everyone may ask the shell for something.
  useEffect(() => {
    const onSearch = (e: Event) => {
      const d = (e as CustomEvent<{ query?: SearchQuery; auto?: boolean }>).detail;
      if (!d?.query || typeof d.query !== "object" || !d.query.to || !d.query.when) return;
      const from = d.query.from ?? searchFromRef.current;
      if (!from) return;
      runSearchRef.current({ ...d.query, from }, d.auto !== false);
    };
    const onTrip = (e: Event) => {
      const d = (e as CustomEvent<{ trip?: TripResult }>).detail;
      if (d?.trip && Array.isArray(d.trip.legs) && Array.isArray(d.trip.stops)) openTripRef.current(d.trip);
    };
    const onItin = (e: Event) => {
      const d = (e as CustomEvent<Omit<ItinOpen, "n">>).detail;
      if (d && (d.skeleton || d.itinerary)) openItineraryRef.current(d);
    };
    const onPlaceEv = (e: Event) => {
      const d = (e as CustomEvent<{ name?: string; code?: string }>).detail;
      if (d && (d.name || d.code)) openPlaceRef.current(d);
    };
    const onCommand = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text?.trim();
      if (!text) return;
      const best = parseCommand(text, todayIso())[0];
      if (best) runCommandRef.current(best);
    };
    // The route card is gone: a route asked from elsewhere is a search to that place on those days.
    const onRoute = (e: Event) => {
      const d = (e as CustomEvent<{ from?: string; to?: string; depart?: string; nights?: number; flex?: number; oneWay?: boolean }>).detail ?? {};
      if (!d.to) return;
      runCommandRef.current({ kind: "route", from: d.from, to: d.to, depart: d.depart, nights: d.nights, flex: d.flex, oneWay: d.oneWay === true || d.nights === 0, label: d.to });
    };
    // A route the chat already computed opens as a trip page at once (the card it came from, else the cheapest), no second search.
    const onRouteResult = (e: Event) => {
      const d = (e as CustomEvent<{ result?: RouteResult; option?: number }>).detail;
      const r = d?.result;
      if (!r || !Array.isArray(r.options) || !r.options.length) return;
      const cheapest = r.cheapest ? r.options.indexOf(r.cheapest) : -1;
      const i = d.option != null && r.options[d.option] ? d.option : cheapest >= 0 ? cheapest : 0;
      try {
        openTripRef.current(tripFromRouteOption(r, r.options[i], { locate: locateRef.current }));
      } catch {
        setNotice("That route could not be opened; ask again or search for it.");
      }
    };
    const onWalk = (e: Event) => {
      const d = (e as CustomEvent<{ params?: WalkQuery }>).detail;
      void runWalkRef.current(d?.params && typeof d.params === "object" ? d.params : {});
    };
    const onWalkResult = (e: Event) => {
      const d = (e as CustomEvent<{ result?: WalkResult; params?: WalkQuery }>).detail;
      if (d?.result && Array.isArray(d.result.loops)) showWalkResultRef.current(d.result, d.params);
    };
    const onWalkLive = (e: Event) => drawWalkLiveRef.current((e as CustomEvent<{ id?: string; params?: WalkQuery; lines?: unknown[] }>).detail);
    const on: [string, (e: Event) => void][] = [
      ["atlas:search", onSearch],
      ["atlas:trip", onTrip],
      ["atlas:itinerary", onItin],
      ["atlas:place", onPlaceEv],
      ["atlas:command", onCommand],
      ["atlas:route", onRoute],
      ["atlas:route-result", onRouteResult],
      ["atlas:walk", onWalk],
      ["atlas:walk-result", onWalkResult],
      ["atlas:walk-live", onWalkLive],
    ];
    for (const [k, f] of on) window.addEventListener(k, f);
    return () => {
      for (const [k, f] of on) window.removeEventListener(k, f);
    };
  }, []);

  // ---- Play the route: the camera flies home, then to each stop in turn, then home, 2.5 s a hop;
  // any touch of the globe stops it.
  function stopPlay() {
    const cur = playRef.current;
    if (cur) {
      cur.cancelled = true;
      window.clearTimeout(cur.timer);
    }
    playRef.current = null;
    playStopRef.current = null;
    setPlaying(null);
  }
  stopPlayRef.current = stopPlay;
  function playRoute() {
    const map = mapRef.current;
    if (!map || !route || !route.stops.length) return;
    stopPlay();
    const pts: [number, number][] = [...(route.home ? [route.home] : []), ...route.stops.map((s) => [s.lon, s.lat] as [number, number]), ...(route.home ? [route.home] : [])];
    const first = route.home ? -1 : 0;
    const state = { timer: 0, cancelled: false };
    playRef.current = state;
    spinRef.current = false;
    const phone = isPhone();
    if (phone) {
      sheetRef.current = "peek";
      setSheet("peek");
    }
    let i = first;
    const step = () => {
      if (state.cancelled) return;
      const k = i - first;
      const isStop = i >= 0 && i < route.stops.length;
      setPlaying(i);
      playStopRef.current = isStop ? pts[k] : null;
      map.flyTo({ center: pts[k], zoom: isStop ? (phone ? 5.2 : 6) : 3.6, duration: 2200, easing: (t) => 1 - Math.pow(1 - t, 3), padding: panelPadding(), essential: true });
      i++;
      if (k + 1 < pts.length) state.timer = window.setTimeout(step, 2500);
      else
        state.timer = window.setTimeout(() => {
          stopPlay();
          if (phone) setSheet("half");
        }, 2800);
    };
    step();
  }
  function focusStop(i: number) {
    const s = route?.stops[i];
    const map = mapRef.current;
    if (!s || !map) return;
    stopPlay();
    revealMap();
    map.flyTo({ center: [s.lon, s.lat], zoom: 6, duration: 1400, padding: panelPadding() });
  }
  useEffect(() => stopPlay, [openTrip?.id, itin?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- The chat asking the globe to pick a region, a period or a place.
  function selectRegion(key: string) {
    const c = REGION_CENTROIDS[key];
    const map = mapRef.current;
    if (c && map) {
      spinRef.current = false;
      map.flyTo({ center: [c[1], c[0]], zoom: 2.8, duration: 1600, padding: panelPadding() });
    }
    picked({ mode: "region", region: key });
  }
  function picked(detail: PickedDetail) {
    // Cleared before the event goes out: a tap on a pin reaches both deck.gl and the map in
    // the same tick, and the chat must hear one answer, not two.
    pickRef.current = null;
    setPick(null);
    window.dispatchEvent(new CustomEvent("atlas:picked", { detail }));
    if (isPhone() && tabRef.current === "chat") setSheet("full");
  }
  pickedRef.current = picked;
  function cancelPick() {
    pickRef.current = null;
    setPick(null);
    if (isPhone() && tabRef.current === "chat") setSheet("full");
  }
  useEffect(() => {
    const onPick = (e: Event) => {
      const d = (e as CustomEvent<{ mode?: PickMode }>).detail;
      if (d?.mode !== "region" && d?.mode !== "dates" && d?.mode !== "place") return;
      setPick(d.mode);
      if (isPhone()) setSheet(d.mode === "dates" ? "full" : "peek");
      if (d.mode === "region") {
        spinRef.current = false;
        mapRef.current?.flyTo({ center: [50, 15], zoom: 1.5, duration: 1600, essential: true });
      }
    };
    window.addEventListener("atlas:pick", onPick);
    return () => window.removeEventListener("atlas:pick", onPick);
  }, []);

  // On a phone the sheet opens fully for a conversation, and to half for a trip page.
  useEffect(() => {
    if (!isPhone()) return;
    if (tab === "chat" && !openTrip) setSheet("full");
  }, [tab, openTrip]);

  const busy = searchStatus.status === "loading" || walk.status === "loading";

  // ---- Tags on the globe: the lit route's numbered stops first, then the walk's thinking, the
  // place page's city, the regions to pick, and the results' prices.
  const litId = openTrip?.id ?? hoverId;
  const labelItems = useMemo<LabelItem[]>(() => {
    const out: LabelItem[] = [];
    if (route) out.push(...route.stops.map((st, i) => ({ key: `stop:${i}`, lon: st.lon, lat: st.lat, text: `${i + 1} · ${st.name}${st.nights ? ` · ${st.nights}n` : ""}`, kind: "stop" as const, hot: playing === i })));
    if (walkShowing && walk.status === "loading") {
      const onLoop = new Set(route?.stops.map((st) => st.code) ?? []);
      for (const n of [...walk.nodes].reverse()) if (n.code !== "HOME" && !onLoop.has(n.code)) out.push({ key: `walk:node:${n.code}`, lon: n.lon, lat: n.lat, text: n.name, sub: n.money != null ? `€${n.money} so far` : shortDate(n.date), kind: "walk" });
      for (const e of walk.edges.slice(-60).reverse()) if (walkClock - e.at < EDGE_TAG_MS) out.push({ key: `walk:edge:${e.from}>${e.to}>${e.kind}>${Math.round(e.at)}`, lon: e.lon, lat: e.lat, text: `€${Math.round(e.price)}`, kind: "walkedge", cheap: e.price < 40 });
    }
    if (placePage && !itinShowing) out.push({ key: "place:open", lon: placePage.lon, lat: placePage.lat, text: placePage.name, kind: "base", hot: true });
    if (pick === "region") for (const r of WILD_REGIONS) {
      const c = REGION_CENTROIDS[r.key];
      out.push({ key: `region:${r.key}`, lon: c[1], lat: c[0], text: r.label, kind: "region" });
    }
    if (itinShowing || placePage) return out;
    // One tag a place, the cheapest (the list is ranked); the lit trip always has its own.
    const seen = new Set<string>();
    for (const d of resultDots) {
      const k = `${d.p[0].toFixed(2)},${d.p[1].toFixed(2)}`;
      const hot = d.t.id === litId;
      if (seen.has(k) && !hot) continue;
      seen.add(k);
      out.push({ key: `trip:${d.t.id}`, lon: d.p[0], lat: d.p[1], text: `€${doorPrice(d.t)}`, hot, cheap: doorPrice(d.t) < 60 });
    }
    // No sorting: a tag moved in the list replays its pop-in; PriceLabels places hot tags first on its own.
    return out;
  }, [route, playing, walkShowing, walk.status, walk.nodes, walk.edges, walkClock, placePage, itinShowing, pick, resultDots, litId]);
  function pickLabel(key: string) {
    if (key.startsWith("trip:")) {
      const t = shownResults.find((x) => `trip:${x.id}` === key);
      if (t) {
        if (pickRef.current === "place") picked({ mode: "place", place: t.stops[0]?.name ?? t.title });
        else openTripPage(t, tabRef.current === "search" ? lastQueryRef.current : null);
      }
      return;
    }
    if (key.startsWith("region:")) return selectRegion(key.slice(7));
    if (key.startsWith("stop:")) return focusStop(Number(key.slice(5)));
  }

  // ---- Drawing. Animated layers (the trail of the lit route, the pulse at home, the walk, the
  // arrivals) are rebuilt every frame from refs; everything else when state changes.
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
    const ps = playStopRef.current;
    if (ps) {
      const phase = (t % 1.4) / 1.4;
      anim.push(
        new ScatterplotLayer<{ p: [number, number] }>({
          id: "play-pulse",
          data: [{ p: ps }],
          getPosition: (x) => x.p,
          radiusUnits: "pixels",
          getRadius: 8 + phase * 26,
          getFillColor: [111, 240, 196, Math.round(120 * (1 - phase))],
          stroked: true,
          lineWidthUnits: "pixels",
          getLineWidth: 1.5,
          getLineColor: [111, 240, 196, Math.round(200 * (1 - phase))],
          updateTriggers: { getRadius: [phase], getFillColor: [phase], getLineColor: [phase] },
        }),
      );
    }
    // The graph walk as it thinks: every edge grows from its city and fades to a faint line
    // (flights as great circles, trains and coaches dashed), a chosen edge brightens and stays,
    // the cities being expanded pulse. Once the walk is done the edges off the best loop dim.
    const wd = walkDrawRef.current;
    const reduced = reducedRef.current;
    if (wd) {
      const now = performance.now();
      const fresh = (e: WalkEdgeView) => now - e.at < EDGE_GROW_MS + EDGE_FADE_MS;
      const moving = !reduced && (wd.fly.some(fresh) || wd.ground.some(fresh) || wd.nodes.length > 0);
      const tick = moving ? Math.floor(now / 33) : -wd.v;
      const alpha = (e: WalkEdgeView): number => {
        if (wd.done && wd.best.has(`${e.from}>${e.to}`)) return 235;
        if (e.chosen) return wd.done ? 90 : 235;
        const floor = wd.done ? 16 : 44;
        if (reduced) return wd.done ? floor : 110;
        const k = Math.max(0, (now - e.at - EDGE_GROW_MS) / EDGE_FADE_MS);
        return Math.round(Math.max(floor, 210 - (210 - floor) * k));
      };
      const pathOf = (e: WalkEdgeView) => (reduced ? e.path : growPath(e.path, (now - e.at) / EDGE_GROW_MS));
      const colorOf = (e: WalkEdgeView, base: [number, number, number]): RGBA => (e.chosen ? [111, 240, 196, alpha(e)] : e.home ? [238, 242, 255, alpha(e)] : [base[0], base[1], base[2], alpha(e)]);
      if (wd.fly.length)
        anim.push(
          new PathLayer<WalkEdgeView>({
            id: "walk-fly",
            data: wd.fly,
            getPath: pathOf,
            getColor: (e) => colorOf(e, [124, 196, 255]),
            getWidth: (e) => (e.chosen ? 2.6 : 1.4),
            widthUnits: "pixels",
            updateTriggers: { getPath: tick, getColor: tick, getWidth: wd.v },
            parameters: { cullMode: "none" },
          }),
        );
      if (wd.ground.length)
        anim.push(
          new PathLayer<WalkEdgeView>({
            id: "walk-ground",
            data: wd.ground,
            getPath: pathOf,
            getColor: (e) => colorOf(e, [255, 180, 84]),
            getWidth: (e) => (e.chosen ? 2.8 : 1.6),
            widthUnits: "pixels",
            extensions: [dashExt],
            getDashArray: [3, 2],
            dashJustified: true,
            updateTriggers: { getPath: tick, getColor: tick, getWidth: wd.v },
            parameters: { cullMode: "none" },
          } as ConstructorParameters<typeof PathLayer<WalkEdgeView>>[0]),
        );
      if (wd.nodes.length) {
        anim.push(
          new ScatterplotLayer<WalkNodeView>({
            id: "walk-nodes",
            data: wd.nodes,
            getPosition: (n) => [n.lon, n.lat],
            radiusUnits: "pixels",
            getRadius: 4.5,
            getFillColor: [238, 242, 255, 235],
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: 1.5,
            getLineColor: [111, 240, 196, 255],
          }),
        );
        const last = wd.nodes[wd.nodes.length - 1];
        const pulsing = reduced ? [] : wd.nodes.filter((n) => n === last || now - n.at < NODE_PULSE_MS);
        if (pulsing.length)
          anim.push(
            new ScatterplotLayer<WalkNodeView>({
              id: "walk-pulse",
              data: pulsing,
              getPosition: (n) => [n.lon, n.lat],
              radiusUnits: "pixels",
              getRadius: (n) => 6 + (((now - n.at) % 1200) / 1200) * 22,
              getFillColor: (n) => [111, 240, 196, Math.round(110 * (1 - ((now - n.at) % 1200) / 1200))],
              stroked: false,
              updateTriggers: { getRadius: tick, getFillColor: tick },
            }),
          );
      }
    }
    // Trips a live search just found: an arc grows from home and fades.
    if (arrivalsRef.current.length) {
      const now = performance.now();
      arrivalsRef.current = arrivalsRef.current.filter((a) => now - a.at < ARRIVAL_MS);
      const shown = arrivalsRef.current.filter((a) => now >= a.at);
      if (shown.length)
        anim.push(
          new PathLayer<Arrival>({
            id: "arrivals",
            data: shown,
            getPath: (a) => (reduced ? a.path : growPath(a.path, (now - a.at) / 700)),
            getColor: (a) => [a.color[0], a.color[1], a.color[2], reduced ? 150 : Math.round(230 * Math.min(1, Math.max(0, 1 - (now - a.at - 900) / (ARRIVAL_MS - 900))))],
            getWidth: 2,
            widthUnits: "pixels",
            updateTriggers: { getPath: now, getColor: now },
            parameters: { cullMode: "none" },
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
      stopPlayRef.current();
    };
    map.on("mousedown", stop);
    map.on("touchstart", stop);
    map.on("wheel", stop);
    // While the chat waits for a place, a tap anywhere on the globe answers with the nearest city.
    map.on("click", (e) => {
      if (pickRef.current !== "place") return;
      const name = cityNearTap(citiesRef.current, e.lngLat.lat, e.lngLat.lng, map.getZoom());
      if (name) pickedRef.current({ mode: "place", place: name });
    });
    map.on("zoom", () => setLowZoom(map.getZoom() < 3.4));
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
    // The map on the window in development only, so a browser test can read the camera.
    if (process.env.NODE_ENV !== "production") (window as unknown as { __atlasMap?: maplibregl.Map }).__atlasMap = map;
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

  // The trail runs along the lit route.
  useEffect(() => {
    trailRef.current = route?.legs.length ? routePath(route.legs) : null;
  }, [route]);

  // deck.gl layers follow the state. The globe needs back-face culling off or arcs disappear.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const legs = route?.legs ?? [];
    const quiet = !!route || itinShowing || !!placePage;
    const layers: (Layer | null)[] = [
      lowZoom
        ? new PathLayer<[number, number][]>({
            id: "lat-grid",
            data: LAT_LINES,
            getPath: (d) => d,
            getColor: [160, 180, 220, 22],
            getWidth: 1,
            widthUnits: "pixels",
            parameters: { cullMode: "none" },
          })
        : null,
      !itinShowing && !placePage && resultDots.length
        ? new ScatterplotLayer<ResultDot>({
            id: "result-dots",
            data: resultDots,
            getPosition: (x) => x.p,
            radiusUnits: "pixels",
            getRadius: (x) => (x.t.id === litId ? 8 : x.t.price < 60 ? 5 : x.t.price < 150 ? 4.2 : 3.4),
            getFillColor: (x) => (x.t.id === litId ? [111, 240, 196, 255] : priceColor(x.t.price)),
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: (x) => (x.t.id === litId ? 2 : 1),
            getLineColor: [255, 255, 255, 180],
            pickable: true,
            updateTriggers: { getRadius: [litId], getFillColor: [litId], getLineWidth: [litId] },
            onClick: (info) => {
              const d = info.object as ResultDot | undefined;
              if (d) pickLabel(`trip:${d.t.id}`);
            },
            onHover: (info) => setHoverId((info.object as ResultDot | undefined)?.t.id ?? null),
          })
        : null,
      sightsOnMap && sights && !itinShowing
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
      legs.length
        ? new ArcLayer<RouteLeg>({
            id: "route-arcs",
            data: legs.filter((l) => l.kind === "fly"),
            getSourcePosition: (x) => x.from,
            getTargetPosition: (x) => x.to,
            getSourceColor: [111, 240, 196, 230],
            getTargetColor: [124, 196, 255, 230],
            getWidth: 3,
            greatCircle: true,
            parameters: { cullMode: "none" },
          })
        : null,
      legs.length
        ? new PathLayer<RouteLeg>({
            id: "route-ground",
            data: legs.filter((l) => l.kind === "ground"),
            getPath: (l) => straightPath(l.from, l.to),
            getColor: [255, 180, 84, 240],
            getWidth: 3.5,
            widthUnits: "pixels",
            extensions: [dashExt],
            getDashArray: [4, 2],
            dashJustified: true,
            parameters: { cullMode: "none" },
          } as ConstructorParameters<typeof PathLayer<RouteLeg>>[0])
        : null,
      routePoints.length
        ? new ScatterplotLayer<{ p: [number, number] }>({
            id: "route-points",
            data: routePoints.map((p) => ({ p })),
            getPosition: (x) => x.p,
            radiusUnits: "pixels",
            getRadius: 5.5,
            getFillColor: [255, 255, 255, 240],
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: 2,
            getLineColor: [111, 240, 196, 255],
          })
        : null,
      new ScatterplotLayer<Airport>({
        id: "airports",
        data: airports,
        getPosition: (a) => [a.lon, a.lat],
        radiusUnits: "pixels",
        getRadius: (a) => (a.size === "large" ? 2.4 : a.size === "medium" ? 1.6 : 1),
        getFillColor: [150, 165, 190, 38],
      }),
      quiet
        ? null
        : new ScatterplotLayer<Gateway>({
            id: "gateways",
            data: gateways.filter((g) => homeAirports.some((h) => h.iata === g.airport.iata)),
            getPosition: (g) => [g.airport.lon, g.airport.lat],
            radiusUnits: "pixels",
            getRadius: 4.5,
            getFillColor: [255, 180, 84, 255],
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: 1,
            getLineColor: [255, 255, 255, 210],
            pickable: true,
          }),
      origin
        ? new ScatterplotLayer<Origin>({
            id: "origin",
            data: [origin],
            getPosition: (x) => [x.lon, x.lat],
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
    // pickLabel only reads refs and state setters; listing it would re-run this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [airports, gateways, homeAirports, origin, lowZoom, resultDots, litId, sightsOnMap, sights, route, routePoints, itinShowing, placePage, render]);

  function share() {
    navigator.clipboard?.writeText(window.location.href).then(
      () => setCopied(true),
      () => setCopied(false),
    );
    setTimeout(() => setCopied(false), 1600);
  }

  // Where "Back" returns to from the itinerary: the page or tab that was in front.
  const backTo = openTrip ? openTrip.title : placePage ? placePage.name : tab === "chat" ? "the chat" : tab === "trips" ? "My trips" : "the results";
  const itineraryView = itin ? (
    <div className="itinview">
      <div className="itinbar">
        <button className="linkbtn" onClick={closeItinerary}>
          ← Back to {backTo}
        </button>
        <span className="sub">Itinerary</span>
      </div>
      <div className="scroll itinscroll">
        <Itinerary
          key={itin.n}
          skeleton={itin.skeleton}
          itinerary={itin.itinerary}
          savedId={itin.savedId ?? (itin.itinerary as SavedItinerary | undefined)?.savedId}
          wishes={itin.wishes}
          pace={itin.pace ?? prefs.pace}
          budget={itin.budget}
          onFocus={(f) => {
            const map = mapRef.current;
            if (!map || !placed(f.lat, f.lon)) return;
            stopPlay();
            spinRef.current = false;
            revealMap();
            map.flyTo({ center: [f.lon, f.lat], zoom: f.zoom ?? 8, duration: 1300, padding: panelPadding(), essential: true });
          }}
          onRoute={(it) => {
            setItinShape(it);
            frameShape(it);
          }}
          onPlay={playRoute}
          onClose={closeItinerary}
          onSaved={() => setHasSaved(true)}
        />
      </div>
    </div>
  ) : null;

  // The chat's context: where the traveller is, their airports, their Been list and the trip style.
  const chatContext: ChatContext & { prefs: Prefs } = { origin: origin ? { lat: origin.lat, lon: origin.lon, label: origin.label } : undefined, gateways: homeAirports.map((g) => g.iata), home: gateways[0]?.airport.country ?? "RO", been: been.countries.length ? { countries: been.countries, newOnly: been.newOnly } : undefined, prefs };

  const searchProps: SearchTabProps = {
    from: searchFrom,
    prefs,
    been,
    run: searchRun,
    active: litId,
    onResults,
    onQuery,
    onOpen: (t) => openTripPage(t, lastQuery),
    onHover: (t) => setHoverId(t?.id ?? null),
  };

  return (
    <div className={`app sheet-${sheet}`}>
      <div className="space" />
      <div ref={mapEl} className="map" />
      <div className="vignette" aria-hidden="true" />
      <PriceLabels map={mapObj} items={labelItems} onPick={pickLabel} onHover={(k) => setHoverId(k && k.startsWith("trip:") ? k.slice(5) : null)} />
      <div className={`progressline${busy ? " on" : ""}`} aria-hidden="true" />
      <TopBar
        origin={origin}
        airports={airports}
        onOrigin={(a) => setOrigin({ lat: a.lat, lon: a.lon, label: a.city ?? a.name, source: "search" })}
        searching={searchStatus.status === "loading"}
        busy={busy}
        onCommand={runCommand}
        onShare={share}
        copied={copied}
        been={been}
        onBeen={setBeen}
        countries={countries}
        prefs={prefs}
      />
      <div className="mapcards">
        {notice && (
          <div className="mapnotice" role="status">
            {notice}
            <button className="iconbtn" onClick={() => setNotice(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
      </div>
      <Panel
        tab={tab}
        onTab={(t) => {
          // A tab chosen closes what sits in front of the tabs.
          setPlacePage(null);
          setOpenTrip(null);
          if (itin) closeItinerary();
          setTab(t);
        }}
        sheet={sheet}
        onSheet={setSheet}
        search={searchProps}
        trip={openTrip}
        tripQuery={openTripQuery}
        onTripBack={() => {
          setOpenTrip(null);
          setHoverId(null);
        }}
        onTripFocus={(f) => {
          const map = mapRef.current;
          if (!map || !placed(f.lat, f.lon)) return;
          stopPlay();
          spinRef.current = false;
          revealMap();
          map.flyTo({ center: [f.lon, f.lat], zoom: f.zoom ?? 6, duration: 1300, padding: panelPadding(), essential: true });
        }}
        onTripItinerary={(t) => openItinerary({ skeleton: skeletonFromTripResult(t, tripOrigin(openTripQuery)) })}
        chatContext={chatContext}
        chatSeed={chatSeed}
        onChatSeedConsumed={() => setChatSeed(null)}
        onChatDeals={onChatDeals}
        onChatTrip={onChatTrip}
        onChatOpenDeal={onChatOpenDeal}
        front={itineraryView}
        placePage={placePage}
        onClosePlace={() => setPlacePage(null)}
        intel={intel}
        summary={summary}
        sights={sights}
        eats={eats}
        onShowSights={showSights}
        onFindTrips={(pl) => {
          const q = withTraveller({ to: { kind: "place", name: pl.name }, when: { kind: "anytime" }, nights: prefs.nightsPerPlace[1] > prefs.nightsPerPlace[0] ? [prefs.nightsPerPlace[0], Math.max(prefs.nightsPerPlace[1], 4)] : [3, 5] });
          if (q) runSearch(q);
        }}
        onPlanPlace={(pl) => {
          const sk = placeSkeleton(pl);
          if (sk) openItinerary({ skeleton: sk });
        }}
        pick={pick}
        pickPeriod={pickPeriod}
        onPickPeriod={setPickPeriod}
        onPicked={picked}
        onPickCancel={cancelPick}
        hasSaved={hasSaved}
        onOpenSaved={(it) => openItinerary({ itinerary: it })}
        searches={saved}
        onRunSearch={(q) => {
          // A saved search runs from the place its row names, with the trip style and the Been list of now.
          const { exclude: _e, prefs: _p, ...rest } = q;
          const run = withTraveller(rest);
          if (run) runSearch(run);
        }}
        onForgetSearch={(at) => setSaved(forgetSearch(at))}
      />
      {manifest && (
        <div
          className="provenance"
          title={Object.values(manifest)
            .map((e) => `${e.source} (${e.licence}, ${e.fetchedAt.slice(0, 10)})`)
            .join("\n")}
        >
          Prices: Kiwi.com, live and searched nightly · Airports: {manifest.airports?.source}
          {weather ? ` · Weather: MET Norway ${weather.updated.slice(0, 10)}` : ""}
          {` · ${Object.keys(manifest).length} sources, hover for all`}
        </div>
      )}
    </div>
  );
}

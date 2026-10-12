"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import { ArcLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import { PathStyleExtension } from "@deck.gl/extensions";
import type { Layer, PickingInfo } from "@deck.gl/core";
import { flightMinutes, formatDuration, haversineKm, nearestGateways } from "@/lib/geo";
import { combinePlaces, type Place } from "@/lib/places";
import type { Trip, TripCity, TripLeg, TripsResult } from "@/lib/trips";
import type { PlaceSummary } from "@/app/api/place/route";
import { fetchBoard, readNdjson } from "@/lib/boards-client";
import { greatCircle, latitudeLines, routePath, type RouteLeg } from "@/lib/arc";
import { isGem, type FameFile } from "@/lib/gems";
import { addDays, countryName, dateRange, daysBetween, localIso, shortDate, todayIso } from "@/lib/format";
import { EMPTY_BEEN, countryAllowed, excludedCountries, excludeParam, filterByCountry, loadBeen, saveBeen, type BeenPrefs } from "@/lib/been";
import { BANDS, dealKey, matchDealKey, REGION_CENTROIDS, TRIP_MODES, WILD_REGIONS, type AskState, type Band, type BoardState, type DealNights, type EventSpot, type EventsLayer, type GroupForm, type GroupState, type LiveSearch, type LongStayForm, type LongStayResult, type LongStayState, type Origin, type Period, type PickMode, type PickedDetail, type PlacePage, type Sheet, type TripMode, type View, EMPTY_WALK, WALK_MAX_EDGES, WALK_PARAM_KEYS, WILD_REGION_COUNTRIES, walkQueryString, type WalkEdgeView, type WalkNodeView, type WalkQuery, type WalkSource, type WalkState } from "@/lib/ui-types";
import { avoidCodes, DEFAULT_PREFS, loadPrefs, nightsParam, nightsRangeParam, prefsQuery, PREFS_EVENT, cleanPrefs, wildStopFit, type Prefs } from "@/lib/prefs";
import type { Airport, City, CityPlaces, CountryInfo, Deal, Destination, FaresResponse, Gateway, HeritageRow, Holiday, Manifest, ReachResponse, ReachStation, Route, VisaFile, WeatherCompact, WeatherFile } from "@/lib/types";
import { expandWeather, visaFor } from "@/lib/types";
import Panel, { MODE_LABEL, type Capabilities, type CombosState, type PlanState, type WildState } from "./Panel";
import { countryIndexOf, EMPTY_LONGSTAY_FORM, EMPTY_TRIPS_EXTRA, emptyGroupForm, firstWeeks, resolveCountries, SHORT_DAYS, shortLoopRoute, WILD_WINDOW_DAYS, type GroupSearch, type LongStayQuery, type TripsExtra, type WildQuery } from "./TripsPanel";
import RouteCard, { emptyRouteForm, EventsCard, eventsHere, optionKey, ROUTE_BUDGET, ROUTE_BUDGET_FREE, ROUTE_BUDGET_HARDER, routeParams, toEventSpot, type RawEvent, type RouteForm, type RouteLeg as AbLeg, type RouteOption, type RouteResult, type RouteState } from "./RouteFinder";
import { eventsInWindow } from "@/lib/purpose-events";
import { parseCommand, type Command } from "@/lib/command";
import type { WalkEvent, WalkLoop, WalkResult } from "@/lib/graph-walk";
import WalkCard, { WALK_MORE_BUDGET } from "./WalkCard";
import { skeletonFromDeal, skeletonFromEvent, skeletonFromGroup, skeletonFromLongStay, skeletonFromRoute, skeletonFromTrip, skeletonFromWalk, skeletonFromWild, type BudgetTier, type ItinLeg, type ItinPlace, type Itinerary as Itin, type Pace, type Skeleton } from "@/lib/itinerary";
import { existingOwnerId } from "@/lib/owner";
import Itinerary, { type SavedItinerary } from "./Itinerary";
import MyTrips from "./MyTrips";

/**
 * The two ends of an A to B answer as points to frame, only the ones the engine could place:
 * a typo or an unknown name comes back with null coordinates, and framing those would put
 * the camera and a tag on null island.
 */
/** The origin as a place /api/route resolves: its name, or "lat,lon" when the name is only "your location" or "shared location". */
function originAsPlace(o: Origin): string {
  return o.label === "your location" || o.label === "shared location" ? `${o.lat.toFixed(3)},${o.lon.toFixed(3)}` : o.label;
}
function routeEnds(r: RouteResult): [number, number][] {
  const pts: [number, number][] = [];
  for (const end of [r.from, r.to]) if (routeEndKnown(end)) pts.push([end.lon, end.lat]);
  return pts;
}
/**
 * An end the engine placed for real: `placed: false` means it borrowed the other end's
 * coordinates (or 0,0) so a frame still lands somewhere; a tag there would sit on the wrong
 * city or on null island.
 */
function routeEndKnown(end: RouteResult["from"]): boolean {
  return end.placed !== false && Number.isFinite(end.lat) && Number.isFinite(end.lon);
}
import type { FinderQuery, FinderState } from "./FinderForm";
import type { Plan } from "@/lib/plan";
import type { EatsResponse } from "@/app/api/eats/route";
import type { HotelsResult } from "@/lib/liteapi";
import type { WildLeg, WildStop, WildTrip } from "@/lib/wild";
import type { Sights, Sight } from "@/app/api/sights/route";
import TopBar from "./TopBar";
import type { ChatContext } from "./ChatPanel";
import PriceLabels, { type LabelItem } from "./PriceLabels";
import type { Intel } from "./PlaceIntel";

// The modes of the Trips tab: the trip builders. "ab" and "purpose" in an old link open the
// route card and the Events layer instead (see the first effect).
const TRIP_MODE_KEYS: TripMode[] = TRIP_MODES.map((m) => m.key);
/** What the itinerary view was opened with: a skeleton to generate, or an itinerary already written (a saved one). n keys the component, so a new open starts fresh. */
type ItinOpen = { skeleton?: Skeleton; itinerary?: Itin; wishes?: string; pace?: Pace; budget?: BudgetTier; savedId?: string; n: number };

/** One line of the /api/walk stream. */
type WalkLine = {
  node?: Omit<WalkNodeView, "at" | "money">;
  edge?: Omit<WalkEdgeView, "at" | "path">;
  loop?: { loop: WalkLoop } | WalkLoop;
  progress?: string;
  done?: WalkResult;
  error?: string;
};
/**
 * One line of the /api/wild stream: progress, the finished trip, an error, and on the walk
 * engine the walk behind it, one {walk} line per step (a WalkEvent: a node, an edge, a loop,
 * a progress line). A line already in the /api/walk shape is taken as it is.
 */
type WildLine = { progress?: string; trip?: WildTrip; error?: string; walk?: WalkEvent | WalkLine };
/** A walk step from the Wild stream in the shape the walk drawer reads. */
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
/** Something a live search just found, drawn growing from where it leaves and fading out (deals, route options). */
type Arrival = { path: [number, number][]; at: number; color: RGBA; ground?: boolean };
/** How long an arrival or a walk edge's price tag stays lit, in milliseconds. */
const ARRIVAL_MS = 2600;
const EDGE_TAG_MS = 3500;
/** The walk's edges grow from their node over this long, then fade to a faint line over EDGE_FADE_MS. */
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
/** The curated event kinds (lib/purpose-events.ts): a command-line word naming one filters by kind. */
const EVENT_KINDS = new Set(["festival", "sport", "culture", "season", "music", "food"]);
/** "Brașov" and "brasov" are one key for a place typed on the command line. */
function foldName(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
/** Region words a traveller types, to the Wild regions' keys; anything else is tried as a country. */
const REGION_WORDS: Record<string, string> = {
  "southeast asia": "sea", "south east asia": "sea", "se asia": "sea", asia: "sea", indochina: "sea",
  "east asia": "east-asia", "south asia": "south-asia", "central asia": "central-asia", "silk road": "central-asia", stans: "central-asia",
  caucasus: "caucasus", turkey: "caucasus", balkans: "balkans", "north africa": "north-africa", levant: "north-africa", "middle east": "gulf", gulf: "gulf",
  "east africa": "east-africa", africa: "east-africa", "southern africa": "southern-africa", "north america": "americas", "central america": "americas", america: "americas", americas: "americas",
  caribbean: "caribbean", "south america": "south-america", "latin america": "south-america", oceania: "oceania", australia: "oceania", pacific: "oceania",
};
/** Two itinerary places are the same spot: the same code, or the same name. */
function sameSpot(a: ItinPlace, b: ItinPlace): boolean {
  return (!!a.code && a.code === b.code) || foldName(a.name) === foldName(b.name);
}
function regionKey(word: string | undefined): string | null {
  if (!word) return null;
  const w = foldName(word);
  if (WILD_REGIONS.some((r) => r.key === w)) return w;
  const byLabel = WILD_REGIONS.find((r) => foldName(r.label) === w || foldName(r.label).startsWith(w));
  return byLabel?.key ?? REGION_WORDS[w] ?? null;
}
const LAT_LINES = latitudeLines(15);
const isPhone = () => typeof window !== "undefined" && window.innerWidth <= 720;

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

// The city nearest a tap on the bare globe, within about thirty pixels at the current zoom
// (never under 30 km), so a place pick works on any town, not only on a pin.
function cityNearTap(cities: Record<string, City>, lat: number, lon: number, zoom: number): string | null {
  const metresPerPx = (156543.03 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
  const radiusKm = Math.max(30, (30 * metresPerPx) / 1000);
  let best: City | null = null;
  let bestKm = radiusKm;
  for (const c of Object.values(cities)) {
    // A degree of latitude is 111 km: skip the far ones before the trigonometry.
    if (Math.abs(c.lat - lat) * 111 > radiusKm) continue;
    const km = haversineKm(lat, lon, c.lat, c.lon);
    if (km < bestKm) {
      bestKm = km;
      best = c;
    }
  }
  return best?.name ?? null;
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
  const [wildTradeoff, setWildTradeoff] = useState("price");
  const [wildVariants, setWildVariants] = useState(1);
  const [wildPeriod, setWildPeriod] = useState<Period>({ from: "", to: "" });
  const [plan, setPlan] = useState<PlanState>({ status: "idle" });
  const [tripMode, setTripMode] = useState<TripMode>("short");
  // The route card floating on the map: open from anywhere (the command line, atlas:route,
  // a Get there block, the chat's atlas:route-result), it stays open across tabs; folded, the
  // globe goes back to drawing what is under it.
  const [routeCard, setRouteCard] = useState<{ open: boolean; collapsed: boolean }>({ open: false, collapsed: false });
  // The Events layer: markers and tags at the cities of the events worth flying for, and the card for one of them.
  const [evLayer, setEvLayer] = useState<EventsLayer>({ on: false, from: "", to: "", list: false });
  const [eventSel, setEventSel] = useState<EventSpot | null>(null);
  // A place page opened from anywhere (atlas:place, the command line, an event's city).
  const [placePage, setPlacePage] = useState<PlacePage | null>(null);
  // The itinerary view in the panel, and the shape it asked the globe to draw (onRoute).
  const [itin, setItin] = useState<ItinOpen | null>(null);
  const [itinShape, setItinShape] = useState<Skeleton | Itin | null>(null);
  // Whether this browser has an owner id, i.e. has saved an itinerary: the Trips tab lists them then.
  const [hasSaved, setHasSaved] = useState(false);
  useEffect(() => {
    setHasSaved(!!existingOwnerId());
  }, []);
  // A one-line note on the map (a command that could not run, a place not found); clears itself.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);
  // The free-form extras of every Trips mode (countries, must-include cities, wishes, ...): see TripsPanel.TripsExtra.
  const [tripsExtra, setTripsExtra] = useState<TripsExtra>(EMPTY_TRIPS_EXTRA);
  // A to B: the form, the streamed answer, the option drawn on the globe, and the request in flight.
  const [abForm, setAbForm] = useState<RouteForm>(emptyRouteForm);
  // The current form for the event listeners, which are registered once and would otherwise see the first, empty one.
  const abFormRef = useRef(abForm);
  abFormRef.current = abForm;
  const [ab, setAb] = useState<RouteState>({ status: "idle", lines: [], options: [] });
  const [abSelected, setAbSelected] = useState<number | null>(null);
  // The traveller's trip style (lib/prefs.ts): read from this browser once mounted (the server
  // render has no storage), then kept in step with the Trip style control through its
  // 'atlas:prefs' event.
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  useEffect(() => {
    setPrefs(loadPrefs());
    const onPrefs = (e: Event) => setPrefs(cleanPrefs((e as CustomEvent<{ prefs?: unknown }>).detail?.prefs));
    window.addEventListener(PREFS_EVENT, onPrefs);
    return () => window.removeEventListener(PREFS_EVENT, onPrefs);
  }, []);
  // The trip style is the default of every builder: when it changes, the forms start from it
  // again (nights a stop back to the style, its tradeoff, its longest flight). A form changed
  // after that holds for its own searches until the style changes once more.
  useEffect(() => {
    setWildTradeoff(prefs.tradeoff);
    // The Smart loop's chip key ("2" or "2-3"); runSmartLoop sends the style's exact range when it is chosen.
    const perStop = nightsParam(prefs);
    const smartStyle = prefs.taste === "unique" ? "unique" : prefs.tradeoff === "price" ? "cheapest" : "balanced";
    setTripsExtra((x) => ({ ...x, wild: { ...x.wild, stopNights: null, maxHours: prefs.maxFlightHours ?? 0 }, smart: { ...x.smart, perStop, style: smartStyle } }));
  }, [prefs]);
  const abCtrl = useRef<AbortController | null>(null);
  // The getaway finder's running stream: a newer search (one keystroke on the command line) stops it.
  const finderCtrl = useRef<AbortController | null>(null);
  const [longStay, setLongStay] = useState<LongStayState>({ status: "idle" });
  const [selectedBase, setSelectedBase] = useState<string | null>(null);
  const [group, setGroup] = useState<GroupState>({ status: "idle" });
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  // The Long stay and Group forms live here, not in the panel: the panel unmounts on a tab
  // or mode switch, and the visitor expects the form that produced the results to still be
  // there when they come back (and the group editor's "defaults applied once" flag with it).
  const [longStayForm, setLongStayForm] = useState<LongStayForm>(EMPTY_LONGSTAY_FORM);
  const [groupForm, setGroupForm] = useState<GroupForm>(emptyGroupForm);
  // The chat asking the globe to pick a region, a period or a place (atlas:pick events).
  const [pick, setPick] = useState<PickMode | null>(null);
  const [pickPeriod, setPickPeriod] = useState<Period>({ from: "", to: "" });
  const pickRef = useRef<PickMode | null>(null);
  pickRef.current = pick;
  // The map's own click handler is registered once, so it reads the latest state through refs.
  const viewRef = useRef<View>("deals");
  const citiesRef = useRef<Record<string, City>>({});
  const pickedRef = useRef<(d: PickedDetail) => void>(() => {});
  // Playing the route: the index of the stop the camera is on (-1 home, n home again).
  const [playing, setPlaying] = useState<number | null>(null);
  const playRef = useRef<{ timer: number; cancelled: boolean } | null>(null);
  const playStopRef = useRef<[number, number] | null>(null);
  const stopPlayRef = useRef<() => void>(() => {});
  const [lowZoom, setLowZoom] = useState(true);
  const [finder, setFinder] = useState<FinderState>({ status: "idle", deals: [], lines: [] });
  const [chatDeals, setChatDeals] = useState<Deal[]>([]);
  const [chatTrip, setChatTrip] = useState<WildTrip | null>(null);
  const [chatSeed, setChatSeed] = useState<string | null>(null);

  const [boards, setBoards] = useState<Record<string, BoardState>>({});
  const [month, setMonth] = useState<string | null>(null);
  // "Been": the countries already visited. Browser only (localStorage), never in the URL.
  const [been, setBeenState] = useState<BeenPrefs>(EMPTY_BEEN);
  useEffect(() => {
    setBeenState(loadBeen());
  }, []);
  const setBeen = useCallback((p: BeenPrefs) => {
    setBeenState(p);
    saveBeen(p);
  }, []);
  // The countries a search must not land in: the list when "only new" is on, else nothing.
  const exclude = useMemo(() => excludedCountries(been), [been]);
  const excludeQ = excludeParam(been);
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
  // The graph walk (GET /api/walk): its stream as state for the card and the tags, the request
  // in flight, and what the animation loop draws every frame (walkDrawRef, set from the state).
  const [walk, setWalk] = useState<WalkState>(EMPTY_WALK);
  const walkCtrl = useRef<AbortController | null>(null);
  /** Where each city the walk expanded sits, and the money its chosen way in cost so far: edges start from these points. */
  const walkNodesRef = useRef(new Map<string, { p: [number, number]; money?: number }>());
  /** Whether the visitor picked a loop in the card: a better loop arriving then does not take the stage from it. */
  const walkPickedRef = useRef<string | null>(null);
  const walkDrawRef = useRef<{ fly: WalkEdgeView[]; ground: WalkEdgeView[]; nodes: WalkNodeView[]; done: boolean; best: Set<string>; v: number } | null>(null);
  // A clock for the tags that come and go (an edge's price shows for a few seconds): ticks only while a walk streams.
  const [walkClock, setWalkClock] = useState(0);
  // Deals and route options arriving from a live search, drawn growing in by the animation loop.
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
  sheetRef.current = sheet;
  viewRef.current = view;
  citiesRef.current = cities;

  // On a phone a sheet opened full hides the globe; anything that frames or flies the camera
  // drops it to half first, and reads the padding of that half through sheetRef at once.
  const revealMap = useCallback(() => {
    if (!isPhone() || sheetRef.current !== "full") return;
    sheetRef.current = "half";
    setSheet("half");
  }, []);

  // Keep the interesting part of the globe clear of the panel: right of it on desktop, above
  // the sheet on phones.
  const cardOpenRef = useRef(false);
  const panelPadding = useCallback(() => {
    if (typeof window !== "undefined" && window.innerWidth <= 720) {
      const s = sheetRef.current;
      // A full sheet leaves no map to frame into (globals.css: 100vh minus the top bar); the
      // callers drop it to half through revealMap() first, so "full" pads like "half" here
      // rather than asking MapLibre for a padding larger than the viewport.
      const sheetBottom = (s === "peek" ? 150 : Math.round(window.innerHeight * 0.56)) + 24;
      // A card floating above the sheet (the walk, the route) covers the globe too: frame above it,
      // but always leave a strip of at least 160 px to frame into.
      const cards = document.querySelector(".mapcards");
      const r = cards && cards.children.length ? cards.getBoundingClientRect() : null;
      const above = r && r.height > 0 ? window.innerHeight - r.top + 12 : 0;
      return { left: 16, right: 16, top: 140, bottom: Math.min(Math.max(sheetBottom, above), window.innerHeight - 140 - 160) };
    }
    // The route or event card floats over the right of the map: frame clear of it too. The
    // panel's width and the top bar's height come from globals.css (narrower on tablets, where
    // the command line takes a row of its own), and left plus right never eat the whole map:
    // at least 240 px stay between them.
    const w = window.innerWidth;
    const css = getComputedStyle(document.documentElement);
    const panelW = parseFloat(css.getPropertyValue("--panel-w")) || 468;
    const topbar = parseFloat(css.getPropertyValue("--topbar")) || 64;
    const left = panelW + 36;
    const card = cardOpenRef.current ? Math.min(380, w - panelW - 48) + 40 : 60;
    const right = Math.max(40, Math.min(card, w - left - 240));
    return { left: Math.min(left, Math.max(40, w - right - 240)), top: topbar + 20, right, bottom: 60 };
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

  // "wild" was a tab of its own; it is now the Wild mode of the Trips tab, and old links keep working.
  const changeView = useCallback((v: View) => {
    if (v === "wild") {
      setView("trips");
      setTripMode("wild");
    } else setView(v);
  }, []);
  const wildOpen = view === "trips" && tripMode === "wild";
  const shortOpen = view === "trips" && tripMode === "short";

  // The address bar follows the globe, so any view is a link.
  useEffect(() => {
    if (!origin) return;
    const q = new URLSearchParams();
    q.set("from", `${origin.lat.toFixed(3)},${origin.lon.toFixed(3)},${origin.label}`);
    if (month) q.set("month", month);
    if (view !== "deals") q.set("view", view);
    if (view === "trips" && tripMode !== "short") q.set("mode", tripMode);
    if (shortOpen && days !== 5) q.set("days", String(days));
    if (selectedPlace && view !== "deals") q.set("place", selectedPlace);
    if (selectedDeal && view === "deals") q.set("deal", selectedDeal);
    if (selectedTrip && shortOpen) q.set("trip", selectedTrip);
    const url = `${window.location.pathname}?${q.toString()}`;
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", url);
  }, [origin, month, view, tripMode, shortOpen, days, selectedPlace, selectedDeal, selectedTrip]);

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
    // The visitor's own calendar days: toISOString would name the UTC day, which is already
    // Sunday for a Friday evening in Lima and reads the wrong weekend's weather.
    return [localIso(sat), localIso(sun)];
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
    if (v === "chat" || v === "deals" || v === "all" || v === "fly" || v === "ground" || v === "trips" || v === "wild") changeView(v);
    const mode = q.get("mode");
    if (mode && TRIP_MODE_KEYS.includes(mode as TripMode)) setTripMode(mode as TripMode);
    // A to B and Purpose were Trips modes; their old links open the capability that replaced them.
    if (mode === "ab") setRouteCard({ open: true, collapsed: false });
    if (mode === "purpose") setEvLayer((l) => ({ ...l, on: true, list: true }));
    if (from && from.length >= 2 && Number.isFinite(Number(from[0])) && Number.isFinite(Number(from[1]))) {
      setOrigin({ lat: Number(from[0]), lon: Number(from[1]), label: from.slice(2).join(",") || "shared location", source: "search" });
      const d = Number(q.get("days"));
      if (SHORT_DAYS.includes(d)) setDays(d);
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
          deals: (ds, live) => {
            if (live) arriveDealsRef.current(ds);
            setBoards((b) => {
              const cur = b[g.iata];
              if (!cur) return b;
              const seen = new Set(cur.deals.map(dealKey));
              const add = ds.filter((d) => !seen.has(dealKey(d)));
              return add.length ? { ...b, [g.iata]: { ...cur, deals: [...cur.deals, ...add] } } : b;
            });
          },
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
  // A custom search replaces tonight's boards until it is cleared.
  // Stored boards never saw the Been list, so deals landing in an excluded country are dropped here too.
  // The chat's deals are left alone: its tools already filter, and the traveller can tell the
  // chat that a been country is fine this once, which must then show on the globe as well.
  const dealsAll = useMemo(
    () => (view === "chat" && chatDeals.length ? chatDeals : filterByCountry(finder.status === "idle" ? boardList.flatMap((b) => b.deals) : finder.deals, exclude)),
    [boardList, finder, view, chatDeals, exclude],
  );
  async function runFinder(q: FinderQuery) {
    // One finder search at a time: the older stream is stopped, so its deals never land in the
    // newer list and it spends no more live Kiwi searches. Every await below checks it is still current.
    finderCtrl.current?.abort();
    const ctrl = new AbortController();
    finderCtrl.current = ctrl;
    const stale = () => finderCtrl.current !== ctrl;
    setFinder({ status: "loading", query: q, deals: [], lines: [] });
    setSelectedDeal(null);
    setAsk(null);
    const params = new URLSearchParams({ origins: q.origins.join(","), from: q.from, to: q.to, minNights: String(q.minNights), maxNights: String(q.maxNights), where: q.where });
    if (q.include) params.set("include", q.include);
    if (q.direct) params.set("direct", "1");
    if (q.maxHours) params.set("maxHours", String(q.maxHours));
    if (q.returnTo.length) params.set("returnTo", q.returnTo.join(","));
    if (q.tricks) params.set("tricks", "1");
    if (q.exhaustive) params.set("exhaustive", "1");
    // Where the traveller is, on every search: the paired search scores each home airport by the
    // train, coach or drive from it to them, and the exhaustive one grows the origins from here.
    if (origin) {
      params.set("lat", String(origin.lat));
      params.set("lon", String(origin.lon));
    }
    if (excludeQ) params.set("exclude", excludeQ);
    try {
      const r = await fetch(`/api/finder?${params}`, { signal: ctrl.signal });
      if (stale()) return;
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        if (!stale()) setFinder({ status: "error", query: q, deals: [], lines: [], note: j.error ?? `failed (${r.status})` });
        return;
      }
      if (!r.headers.get("content-type")?.includes("ndjson")) {
        const j = (await r.json()) as { deals: Deal[]; searched: number };
        if (!stale()) setFinder({ status: "ok", query: q, deals: j.deals, lines: [], searched: j.searched });
        return;
      }
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (stale()) {
          void reader.cancel().catch(() => {});
          return;
        }
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
          if (!line) continue;
          try {
            const msg = JSON.parse(line) as { progress?: string; deals?: Deal[]; done?: { searched: number; count: number; note?: string }; error?: string };
            if (msg.progress) setFinder((f) => ({ ...f, lines: [...f.lines, msg.progress!] }));
            if (msg.deals) arriveDealsRef.current(msg.deals);
            if (msg.deals) setFinder((f) => { const seen = new Set(f.deals.map(dealKey)); return { ...f, deals: [...f.deals, ...msg.deals!.filter((d) => !seen.has(dealKey(d)))] }; });
            // done.note is the route's explanation of an empty answer (rate-limited); the panel shows it where the deals would be.
            if (msg.done) { finished = true; setFinder((f) => ({ ...f, status: "ok", searched: msg.done!.searched, note: msg.done!.note })); }
            if (msg.error) { finished = true; setFinder((f) => ({ ...f, status: "error", note: msg.error })); }
          } catch {
            // partial line
          }
        }
      }
      if (!finished) setFinder((f) => ({ ...f, status: f.deals.length ? "ok" : "error", note: f.deals.length ? undefined : "the search stopped early" }));
    } catch {
      // An abort is a newer search (or a clear) taking over: it owns the state now.
      if (!stale()) setFinder({ status: "error", query: q, deals: [], lines: [], note: "network" });
    } finally {
      if (finderCtrl.current === ctrl) finderCtrl.current = null;
    }
  }
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
  /**
   * Deals that a live search just found (the finder's stream, a live board) draw an arc from
   * their home airport that grows in and fades, while the price tag pops in at the city. A
   * ref, so the stream handlers registered earlier always use the coordinates of now.
   */
  const arriveDealsRef = useRef<(ds: Deal[]) => void>(() => {});
  arriveDealsRef.current = (ds: Deal[]) => {
    const now = performance.now();
    const list = arrivalsRef.current;
    ds.slice(0, 40).forEach((d, i) => {
      const g = gwCoord(d.gw);
      const c = dealCoord(d);
      // Staggered a little, so a batch of fifteen reads as fifteen arrivals rather than one flash.
      if (g && c) list.push({ path: greatCircle(g, c, 40), at: now + i * 70, color: priceColor(d.price) });
    });
    if (list.length > 120) list.splice(0, list.length - 120);
  };
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
  // A deal opened from the chat may not be on tonight's boards.
  const deal = selectedDeal ? (dealsAll.find((d) => matchDealKey(d, selectedDeal)) ?? chatDeals.find((d) => matchDealKey(d, selectedDeal)) ?? null) : null;
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
    if (placePage) {
      const c = placePage.code ? cities[placePage.code] : undefined;
      return { code: placePage.code, name: placePage.name, lat: placePage.lat, lon: placePage.lon, country: placePage.country ?? c?.country, pop: c?.pop };
    }
    if (selectedPlace === "here" && origin) {
      let code: string | null = null;
      let bestKm = 40;
      for (const [k, c] of Object.entries(cities)) {
        const km = haversineKm(origin.lat, origin.lon, c.lat, c.lon);
        if (km < bestKm) {
          bestKm = km;
          code = k;
        }
      }
      return { code: code ?? undefined, name: code ? cities[code].name : origin.label, lat: origin.lat, lon: origin.lon, country: code ? cities[code].country : gateways[0]?.airport.country, pop: code ? cities[code].pop : undefined };
    }
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
  }, [view, deal, selected, cities, selectedPlace, origin, placePage]);

  const intel = useMemo<Intel | null>(() => {
    if (!target) return null;
    const code = target.code;
    const city = code ? cities[code] : undefined;
    const countryCode = target.country;
    const horizon = localIso(new Date(Date.now() + 60 * 86_400_000));
    const today = todayIso();
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
    const name = placePage?.name ?? deal?.city ?? (view !== "deals" ? target?.name : undefined);
    if (!name) return;
    const ctrl = new AbortController();
    fetch(`/api/sights?name=${encodeURIComponent(name)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Sights | null) => setSights(j))
      .catch(() => {});
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placePage?.name, deal?.city, view !== "deals" ? target?.name : null]);
  // Rated places to eat and live hotel prices for the deal's city and dates.
  useEffect(() => {
    setEats(null);
    setHotels(null);
    const c = placePage ? ([placePage.lon, placePage.lat] as [number, number]) : deal ? dealCoord(deal) : view !== "deals" && target ? ([target.lon, target.lat] as [number, number]) : null;
    if (!c) return;
    // A place page has no dates, so no hotel prices: eats only.
    if (!deal || placePage) {
      const ctrl = new AbortController();
      fetch(`/api/eats?lat=${c[1].toFixed(4)}&lon=${c[0].toFixed(4)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: EatsResponse | null) => setEats(j))
        .catch(() => {});
      return () => ctrl.abort();
    }
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
  }, [placePage?.lat, placePage?.lon, deal?.dstCity, deal?.out, deal?.back, view !== "deals" ? target?.code ?? target?.name : null]);
  async function findCombosFor() {
    if (!deal) return;
    setCombos({ status: "loading" });
    try {
      const r = await fetch(`/api/combos?gw=${deal.gw}&dst=${deal.dst}&city=${deal.dstCity}&out=${deal.out}&back=${deal.back}&price=${deal.price}${excludeQ ? `&exclude=${excludeQ}` : ""}`);
      const j = await r.json();
      if (!r.ok || j.error) setCombos({ status: "error", note: j.error ?? `failed (${r.status})` });
      else setCombos({ status: "ok", result: j });
    } catch {
      setCombos({ status: "error", note: "network" });
    }
  }
  function showSights() {
    const map = mapRef.current;
    const c = placePage ? ([placePage.lon, placePage.lat] as [number, number]) : deal ? dealCoord(deal) : target ? ([target.lon, target.lat] as [number, number]) : null;
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
  const wildSeqRef = useRef(0);
  const wildCoord = useCallback((code: string): [number, number] | null => gwCoord(code) ?? (cities[code] ? [cities[code].lon, cities[code].lat] : null), [gwCoord, cities]);
  // over: what the command line asked for ("/wild sea 21, 3 nights a stop, unique, flights
  // only"), used at once rather than waiting for the state it also sets to land. Its nights a
  // stop (a pace typed alone arrives as its nights), taste and ground beat the form and the
  // trip style for this one build.
  async function buildWildTrip(over?: { region?: string; countries?: string[]; nights?: number; nightsPerStop?: number | [number, number]; unique?: boolean; ground?: number }) {
    if (!boardGateways.length || !gateways[0]) return;
    // Which build this is: an older one still streaming (or stopped) never writes over a newer one.
    const seq = ++wildSeqRef.current;
    const current = () => wildSeqRef.current === seq;
    setPlan({ status: "idle" });
    // The trip's identity (what /api/plan needs to find the same stored trip) and the extras
    // (where the visitor is) are kept apart: the plan is asked with the identity only.
    const wf = over?.countries ? { ...tripsExtra.wild, countries: over.countries } : tripsExtra.wild;
    const region = over?.region ?? wildRegion;
    const nights = over?.nights ?? wildNights;
    // The graph walk aimed at the region is the engine from now on; the toggle keeps the classic chain.
    const engine = wf.classic ? "classic" : "walk";
    // The engine the route will really use: ranked versions and other start airports are the classic chain's.
    const builtBy = engine === "classic" || wildVariants > 1 || wf.startFrom.length ? "classic" : "walk";
    // Chosen countries replace the region ("custom"); the rest of the free-form fields ride along under the names the engine reads.
    const query: WildQuery = { engine, g: boardGateways.map((g) => g.iata).join(","), home: gateways[0].airport.country, region: wf.countries.length ? "custom" : region, nights: String(nights), style: wildStyle, budget: wildBudget, tradeoff: wildTradeoff, variants: String(wildVariants) };
    if (wf.countries.length) query.countries = wf.countries.join(",");
    if (wf.mustInclude.length) query.mustInclude = wf.mustInclude.join(",");
    if (wf.maxHours) query.maxFlightHours = String(wf.maxHours);
    if (wf.startFrom.length) query.startFrom = wf.startFrom.slice(0, 3).join(",");
    // Nights a stop: the command line's, else the form's own range, else the trip style's,
    // always sent as both ends ("2-3", "2-2") so the engine never falls back to its old long
    // stays. A loop holds at most 16 stops (8 on the classic chain past three nights a stop):
    // a trip too long for that range at its most would be refused, so the range is stretched
    // to the shortest stays that fit, and the form and the first progress line say so.
    const typed = over?.nightsPerStop;
    const asked: [number, number] = typed != null ? (Array.isArray(typed) ? [typed[0], typed[1]] : [typed, typed]) : (wf.stopNights ?? prefs.nightsPerPlace);
    const fit = wildStopFit(asked, nights, builtBy);
    query.nightsPerStop = nightsRangeParam(fit.range);
    const stretchNote = fit.stretched
      ? `${nights} nights at ${asked[0] === asked[1] ? asked[0] : `${asked[0]} to ${asked[1]}`} nights a stop would need ${fit.needed} stops; a loop takes at most ${fit.cap}. Staying ${fit.range[0]} to ${fit.range[1]} nights a stop instead.`
      : null;
    // The trip style's other settings. /api/wild's own style is the kind of trip (experiences,
    // beaches), so "unique places" travels in the wishes the walk, the judge and the planner read.
    const unique = (over?.unique || prefs.taste === "unique") && !/unique|hidden gem|off the beaten/i.test(wf.wishes);
    const wishes = [wf.wishes.trim(), unique ? "unique places and hidden gems over the big hubs" : ""].filter(Boolean).join(", ");
    if (wishes) query.wishes = wishes;
    if (prefs.avoid.length) query.avoid = prefs.avoid.join(",");
    // Ground hops in minutes: the command line's ("flights only" is 0, "only trains between cities" 480), else 0
    // when the trip style has no trains or coaches; absent leaves the engine's own default.
    const ground = over?.ground != null && Number.isFinite(over.ground) ? Math.max(0, Math.round(over.ground)) : prefs.groundOk ? undefined : 0;
    if (ground != null) query.ground = String(ground);
    if (month) query.month = month;
    // The excluded countries are part of the trip's identity: the plan is looked up under the same key.
    if (excludeQ) query.exclude = excludeQ;
    // An explicit departure window beats the month. The engine searches at most ten departure
    // days and the route refuses a wider window, so the window is clipped here, as the form says.
    if (wildPeriod.from) {
      query.from = wildPeriod.from;
      const latest = addDays(wildPeriod.from, WILD_WINDOW_DAYS);
      if (wildPeriod.to) query.to = wildPeriod.to < latest ? wildPeriod.to : latest;
    }
    setWild({ status: "loading", lines: stretchNote ? [stretchNote] : [] });
    const q = new URLSearchParams(query);
    if (origin) {
      q.set("lat", origin.lat.toFixed(4));
      q.set("lon", origin.lon.toFixed(4));
      q.set("label", origin.label);
    }
    // On the walk engine the stream carries the walk's own steps ({walk} lines): the globe draws
    // the search exactly as it draws a Smart loop, through the same stage and the same drawer,
    // and the walk card shows its lines. The build owns walkCtrl while it runs, so the card's
    // Stop, or any newer walk, stops reading it. The trip itself then takes the globe back.
    const walkOn = engine === "walk";
    // A classic build takes the globe from a Wild walk left over from an earlier build.
    if (!walkOn) setWalk((w) => (w.source === "wild" ? EMPTY_WALK : w));
    const ctrl = new AbortController();
    let stale = () => false;
    let drawWalk: ((m: WalkLine) => void) | null = null;
    let toHome = 0;
    if (walkOn) {
      walkCtrl.current?.abort();
      walkCtrl.current = ctrl;
      stale = () => walkCtrl.current !== ctrl;
      const wq: WalkQuery = { ...(walkContext() ?? {}), countries: wf.countries.length ? wf.countries : (WILD_REGION_COUNTRIES[region] ?? []), minNights: nights, maxNights: nights, nightsPerStop: query.nightsPerStop, tradeoff: wildTradeoff };
      const st = startWalkStage(wq, "wild");
      toHome = st.toHome;
      drawWalk = walkLineDrawer(st.home, stale);
    }
    /** The walk's drawing leaves when the trip arrives (or the build fails): the trip's own route draws instead. */
    const endWalk = () => {
      if (!walkOn || !current()) return;
      window.clearTimeout(toHome);
      if (walkCtrl.current === ctrl) walkCtrl.current = null;
      setWalk((w) => (w.source === "wild" ? EMPTY_WALK : w));
    };
    // Stopped from the walk card, or by a newer walk: what the walk drew stays until the next search.
    const stopped = () => {
      if (current()) setWild((w) => (w.status === "loading" ? { status: "error", lines: [], note: "Stopped. The build goes on on the server; asking again in a minute or two gets the finished loop." } : w));
    };
    // The walk card's Stop aborts the controller: the form says so at once, whether or not the body read notices.
    ctrl.signal.addEventListener("abort", stopped, { once: true });
    try {
      const r = await fetch(`/api/wild?${q}`, { signal: ctrl.signal });
      if (!current()) return;
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        endWalk();
        setWild({ status: "error", lines: [], note: j.error ?? `failed (${r.status})` });
        return;
      }
      if (!r.headers.get("content-type")?.includes("ndjson")) {
        const trip = (await r.json()) as WildTrip;
        endWalk();
        setWild({ status: "ok", lines: [], trip, source: "stored", query });
        frameWild(trip);
        return;
      }
      let finished = false;
      const ended = await readNdjson<WildLine>(
        r,
        (msg) => {
          if (!current()) return;
          if (msg.walk && drawWalk && !stale()) drawWalk(walkLineOf(msg.walk));
          if (msg.progress) setWild((w) => ({ ...w, lines: [...w.lines, msg.progress!] }));
          if (msg.trip) {
            finished = true;
            endWalk();
            setWild({ status: "ok", lines: [], trip: msg.trip, source: "live", query });
            frameWild(msg.trip);
          }
          if (msg.error) {
            finished = true;
            endWalk();
            setWild({ status: "error", lines: [], note: msg.error });
          }
        },
        ctrl.signal,
      );
      if (!finished && current()) {
        if (!ended && ctrl.signal.aborted) return stopped();
        endWalk();
        setWild({ status: "error", lines: [], note: "the search stopped early; try again" });
      }
    } catch (err) {
      if ((err as Error | undefined)?.name === "AbortError" || ctrl.signal.aborted) return stopped();
      if (!current()) return;
      endWalk();
      setWild({ status: "error", lines: [], note: "network" });
    }
  }
  async function planWild() {
    if (!boardGateways.length) return;
    setPlan({ status: "loading" });
    // The plan belongs to the trip on screen, so it is asked with the exact query that built
    // it (tradeoff, versions, departure window included), not with the form as it is now.
    const query = wild.query ?? { g: boardGateways.map((g) => g.iata).join(","), region: wildRegion, nights: String(wildNights), style: wildStyle, budget: wildBudget, ...(month ? { month } : {}), ...(excludeQ ? { exclude: excludeQ } : {}) };
    const q = new URLSearchParams(query);
    try {
      const r = await fetch(`/api/plan?${q}`);
      const j = (await r.json()) as Plan & { error?: string };
      if (!r.ok || j.error) setPlan({ status: "error", note: j.error ?? `failed (${r.status})` });
      else setPlan({ status: "ok", plan: j });
    } catch {
      setPlan({ status: "error", note: "network" });
    }
  }
  // Swap the shown trip for one of its ranked alternatives.
  function showAlternative(i: number) {
    const t = wild.trip;
    const alt = t?.alternatives?.[i];
    if (!t || !alt) return;
    const others = [{ variant: t.variant ?? "Best", rank: t.alternatives!.length + 1, score: 0, title: t.title, totals: t.totals, judge: t.judge, outDate: t.outDate, backDate: t.backDate, legs: t.legs, stops: t.stops }, ...t.alternatives!.filter((_, k) => k !== i)];
    const next: WildTrip = { ...t, variant: alt.variant, title: alt.title, totals: alt.totals, judge: alt.judge, outDate: alt.outDate, backDate: alt.backDate, legs: alt.legs, stops: alt.stops, alternatives: others };
    setWild({ ...wild, trip: next });
    setPlan({ status: "idle" });
    frameWild(next);
  }
  // The cheapest base for a month or more in the chosen region: GET /api/longstay.
  async function findLongStay(q: LongStayQuery, region?: string) {
    if (!boardGateways.length || !gateways[0]) return;
    setLongStay({ status: "loading" });
    setSelectedBase(null);
    const params = new URLSearchParams({ g: boardGateways.map((g) => g.iata).join(","), home: gateways[0].airport.country, region: region ?? wildRegion, months: String(q.months), budget: q.budget });
    if (q.startMonth) params.set("startMonth", q.startMonth);
    if (q.countries?.length) params.set("countries", q.countries.join(","));
    // The route reads the "only these cities" pick as mustInclude (those become the only bases).
    if (q.cities?.length) params.set("mustInclude", q.cities.join(","));
    if (q.wishes) params.set("wishes", q.wishes);
    if (excludeQ) params.set("exclude", excludeQ);
    try {
      const r = await fetch(`/api/longstay?${params}`);
      const j = (await r.json().catch(() => ({}))) as Partial<LongStayResult> & { error?: string };
      if (!r.ok || j.error || !Array.isArray(j.bases)) {
        setLongStay({ status: "error", note: j.error ?? `the base search failed (${r.status})` });
        return;
      }
      // skipped, failed, partial and note are the engine's own account of what it left out; the panel shows them.
      setLongStay({ status: "ok", result: { bases: j.bases, searched: j.searched ?? 0, failed: j.failed, partial: j.partial, skipped: j.skipped ?? [], generatedAt: j.generatedAt ?? new Date().toISOString(), note: j.note } });
      framePoints(j.bases.map((b) => [b.lon, b.lat] as [number, number]), 4.5);
    } catch {
      setLongStay({ status: "error", note: "network" });
    }
  }
  // Where a group can meet: POST /api/group with everyone's airports and free windows.
  async function findGroup(q: GroupSearch) {
    setGroup({ status: "loading" });
    setSelectedOption(null);
    try {
      // The exclude list rides on the URL like every other search route; the body carries it too for a route that only reads JSON.
      const r = await fetch(`/api/group${excludeQ ? `?exclude=${excludeQ}` : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(excludeQ ? { ...q, exclude: excludeQ } : q) });
      const j = (await r.json().catch(() => ({}))) as Partial<NonNullable<GroupState["result"]>> & { error?: string };
      if (!r.ok || j.error || !Array.isArray(j.options)) {
        setGroup({ status: "error", note: j.error ?? `the group search failed (${r.status})` });
        return;
      }
      setGroup({ status: "ok", result: { windows: j.windows ?? [], options: j.options, searched: j.searched ?? 0, failed: j.failed, partial: j.partial, generatedAt: j.generatedAt ?? new Date().toISOString() } });
      const pts = j.options.map((o) => wildCoord(o.dstCity)).filter((c): c is [number, number] => !!c);
      for (const m of q.members) for (const o of m.origins) { const c = wildCoord(o); if (c) pts.push(c); }
      framePoints(pts, 4.5);
    } catch {
      setGroup({ status: "error", note: "network" });
    }
  }
  /**
   * The padding to hand fitBounds for a wanted padding. MapLibre adds fitBounds' padding to the
   * padding an earlier flyTo left on the map, so only the difference is asked for; otherwise on
   * a phone the two together leave no room and the camera does not move ("Map cannot fit within canvas").
   */
  function fitPadding(map: maplibregl.Map, want: { left: number; right: number; top: number; bottom: number }) {
    const p0 = map.getPadding();
    return { left: Math.max(0, want.left - (p0.left ?? 0)), right: Math.max(0, want.right - (p0.right ?? 0)), top: Math.max(0, want.top - (p0.top ?? 0)), bottom: Math.max(0, want.bottom - (p0.bottom ?? 0)) };
  }
  function framePoints(pts: [number, number][], maxZoom: number, duration = 1500) {
    const map = mapRef.current;
    if (!map || pts.length === 0) return;
    revealMap();
    const bounds = new maplibregl.LngLatBounds(pts[0], pts[0]);
    for (const q of pts) bounds.extend(q);
    map.fitBounds(bounds, { padding: fitPadding(map, panelPadding()), maxZoom, duration });
  }
  function frameDeals(ds: Deal[]) {
    const pts = ds.map(dealCoord).filter((c): c is [number, number] => !!c);
    if (origin) pts.push([origin.lon, origin.lat]);
    framePoints(pts, 5);
  }
  // The chat's answer takes the stage: the open deal closes and the camera frames the result.
  function frameChatDeals(ds: Deal[]) {
    setSelectedDeal(null);
    const map = mapRef.current;
    const pts = ds.map(dealCoord).filter((c): c is [number, number] => !!c);
    if (map && pts.length && origin) {
      const b = new maplibregl.LngLatBounds([origin.lon, origin.lat], [origin.lon, origin.lat]);
      for (const q of pts) b.extend(q);
      map.fitBounds(b, { padding: panelPadding(), maxZoom: 5, duration: 1400 });
    }
  }
  // ChatPanel stays mounted on every tab, so a slow answer can land while the visitor is on
  // Deals or Trips with a deal open or a form half filled. The result is stored at once (the
  // arcs may draw) but closing the deal, moving the camera and dropping a phone sheet wait
  // until the Ask tab is in front again.
  const pendingChatFrame = useRef<{ kind: "deals"; deals: Deal[] } | { kind: "trip"; trip: WildTrip } | null>(null);
  function onChatDeals(ds: Deal[]) {
    setChatTrip(null);
    setChatDeals(ds);
    if (viewRef.current === "chat") {
      pendingChatFrame.current = null;
      frameChatDeals(ds);
    } else pendingChatFrame.current = { kind: "deals", deals: ds };
  }
  function onChatTrip(t: WildTrip) {
    setChatDeals([]);
    setChatTrip(t);
    if (viewRef.current === "chat") {
      pendingChatFrame.current = null;
      frameWild(t);
    } else pendingChatFrame.current = { kind: "trip", trip: t };
  }
  useEffect(() => {
    const p = pendingChatFrame.current;
    if (view !== "chat" || !p) return;
    pendingChatFrame.current = null;
    if (p.kind === "deals") frameChatDeals(p.deals);
    else frameWild(p.trip);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  // The place the traveller is in, as a place page.
  function showHere() {
    if (!origin) return;
    setView("all");
    setSelectedPlace("here");
  }
  // Frame the stops of a loop, not the way there: the region fills the screen and the long
  // arcs home run off the edge, which reads better on the globe than a half-planet fit.
  function frameWild(trip: WildTrip) {
    const map = mapRef.current;
    if (!map) return;
    const stops = trip.stops.filter((s) => s.lat || s.lon);
    if (!stops.length) return;
    spinRef.current = false;
    revealMap();
    // fitBounds on the globe with a padded viewport lands half a planet off for a loop that
    // also stops in a hub on the way (Istanbul to Bangkok), so the camera goes where the
    // nights are: a nights-weighted centre, zoomed for the spread of the stops.
    const w = stops.reduce((s, x) => s + Math.max(1, x.nights), 0);
    const lon = stops.reduce((s, x) => s + x.lon * Math.max(1, x.nights), 0) / w;
    const lat = stops.reduce((s, x) => s + x.lat * Math.max(1, x.nights), 0) / w;
    const span = Math.max(Math.max(...stops.map((s) => s.lon)) - Math.min(...stops.map((s) => s.lon)), 1.4 * (Math.max(...stops.map((s) => s.lat)) - Math.min(...stops.map((s) => s.lat))), 4);
    const zoom = Math.max(2.2, Math.min(4.5, Math.log2(140 / span) + 1.5));
    map.flyTo({ center: [lon, lat], zoom, duration: 1600, padding: panelPadding(), essential: true });
  }

  // ---- A to B: the route card. GET /api/route streams {progress}, {option} lines and a final {done}.
  // The itinerary view and the open route card each take the globe for themselves: what is
  // drawn underneath (deals, loops, bases) comes back when they close or fold.
  const itinShowing = !!itin && !!itinShape;
  const cardShown = routeCard.open && !routeCard.collapsed;
  // The walk's card holds the globe while it is open and unfolded; it and the route card take
  // turns (opening one folds the other), and an itinerary in front of both wins.
  const walkShowing = walk.open && !walk.collapsed && walk.status !== "idle" && !itinShowing;
  const abShowing = cardShown && !itinShowing && !walkShowing;
  const covered = itinShowing || abShowing || walkShowing;
  function openRouteCard() {
    // Read at once by panelPadding: the card covers the right of the map from this frame on.
    if (!isPhone()) cardOpenRef.current = true;
    // On a phone the card sits above the sheet: the sheet drops to a peek so card and route both show.
    else if (sheetRef.current !== "peek") {
      sheetRef.current = "peek";
      setSheet("peek");
    }
    setRouteCard({ open: true, collapsed: false });
    setWalk((w) => (w.open && !w.collapsed ? { ...w, collapsed: true } : w));
  }
  function cancelRoute() {
    abCtrl.current?.abort();
    abCtrl.current = null;
    setAb((a) => (a.status === "loading" ? { ...a, status: a.options.length ? "ok" : "error", note: a.options.length ? undefined : "stopped" } : a));
  }
  const cheapestIndex = (r: RouteResult): number => Math.max(0, r.options.findIndex((o) => o === r.cheapest || (!!r.cheapest && optionKey(o) === optionKey(r.cheapest))));
  /**
   * One search at a budget (0: the fare memory and the timetables, no live search). A bigger
   * budget on the question on show keeps its options in view while the extra searches run.
   * Resolves to the result, or null when it failed or a newer search replaced it.
   */
  async function runRoute(form: RouteForm, budget: number): Promise<RouteResult | null> {
    abCtrl.current?.abort();
    const ctrl = new AbortController();
    abCtrl.current = ctrl;
    const same = (a?: RouteForm) => !!a && a.from === form.from && a.to === form.to && a.depart === form.depart && a.nights === form.nights && a.oneWay === form.oneWay && a.flex === form.flex;
    setAb((a) => ({ status: "loading", lines: [], options: budget > 0 && same(a.query) ? a.options : [], query: form, budget }));
    if (!(budget > 0 && same(ab.query))) setAbSelected(null);
    let out: RouteResult | null = null;
    const finish = (r: RouteResult) => {
      out = r;
      setAb((a) => ({ ...a, status: "ok", lines: [], options: r.options.length ? r.options : a.options, result: r, budget }));
      // The cheapest option is drawn at once; the visitor taps another to see it instead.
      setAbSelected(r.options.length ? cheapestIndex(r) : null);
      // A side the engine could not place has null coordinates; frame only the known ends, never null island.
      framePoints(routeEnds(r), 6);
    };
    try {
      const r = await fetch(`/api/route?${routeParams({ from: form.from, to: form.to, depart: form.depart, flex: form.flex, nights: form.nights, oneWay: form.oneWay, maxHours: form.maxHours || prefs.maxFlightHours || 0, exclude: excludeQ, budget })}`, { signal: ctrl.signal });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setAb({ status: "error", lines: [], options: [], note: j.error ?? `the route search failed (${r.status})`, query: form, budget });
        return null;
      }
      if (!r.headers.get("content-type")?.includes("ndjson")) {
        finish((await r.json()) as RouteResult);
        return out;
      }
      let finished = false;
      const ended = await readNdjson<{ progress?: string; option?: RouteOption; done?: RouteResult; error?: string }>(
        r,
        (msg) => {
          if (msg.progress) setAb((a) => ({ ...a, lines: [...a.lines, msg.progress!] }));
          // An option already on show (a bigger budget re-streams the stored ones) is not listed twice.
          if (msg.option) {
            const legs = optionLegs(msg.option, undefined);
            const now = performance.now();
            for (const l of legs) arrivalsRef.current.push({ path: l.kind === "fly" ? greatCircle(l.from, l.to, 40) : straightPath(l.from, l.to), at: now, color: l.kind === "fly" ? [124, 196, 255, 230] : [255, 180, 84, 230], ground: l.kind !== "fly" });
          }
          if (msg.option) setAb((a) => (a.options.some((o) => optionKey(o) === optionKey(msg.option!)) ? a : { ...a, options: [...a.options, msg.option!] }));
          if (msg.done) {
            finished = true;
            finish(msg.done);
          }
          if (msg.error) {
            finished = true;
            setAb((a) => ({ ...a, status: a.options.length ? "ok" : "error", note: msg.error }));
          }
        },
        ctrl.signal,
      );
      if (ended && !finished) setAb((a) => ({ ...a, status: a.options.length ? "ok" : "error", note: a.options.length ? undefined : "the search stopped early; try again" }));
    } catch (err) {
      if ((err as Error | undefined)?.name === "AbortError") return null;
      setAb({ status: "error", lines: [], options: [], note: "network", query: form, budget });
    } finally {
      if (abCtrl.current === ctrl) abCtrl.current = null;
    }
    return out;
  }
  /**
   * A question for the card: the free answer first (about a second, no live search), the
   * live search only when the visitor asks or when the free answer found nothing between two
   * places the engine could place. budget given: exactly that.
   */
  async function searchRoute(form: RouteForm, budget?: number) {
    openRouteCard();
    setAbForm(form);
    const b = budget ?? (form.harder ? ROUTE_BUDGET_HARDER : ROUTE_BUDGET_FREE);
    const r = await runRoute(form, b);
    if (budget === undefined && b === ROUTE_BUDGET_FREE && r && r.options.length === 0 && routeEndKnown(r.from) && routeEndKnown(r.to)) await runRoute(form, ROUTE_BUDGET);
  }
  /** An answer computed elsewhere (the chat, a Get there block), shown without a search. */
  function showRouteResult(r: RouteResult, option?: number, q?: { from?: string; to?: string; depart?: string; nights?: number; oneWay?: boolean }) {
    abCtrl.current?.abort();
    const base = emptyRouteForm();
    const firstDate = r.options.flatMap((o) => o.legs).find((l) => l.date)?.date?.slice(0, 10);
    const form: RouteForm = { ...base, from: q?.from ?? r.from.label, to: q?.to ?? r.to.label, depart: q?.depart ?? firstDate ?? base.depart, nights: q?.nights ?? base.nights, oneWay: q?.oneWay ?? !r.options.some((o) => o.back?.length) };
    setAbForm(form);
    // A result with live searches behind it offers "Search harder" next; a free one "Search live".
    setAb({ status: "ok", lines: [], options: r.options, result: r, query: form, budget: r.searched > 0 ? ROUTE_BUDGET : ROUTE_BUDGET_FREE });
    setAbSelected(r.options.length ? (option != null && r.options[option] ? option : cheapestIndex(r)) : null);
    openRouteCard();
    framePoints(routeEnds(r), 6);
  }
  const searchRouteRef = useRef(searchRoute);
  searchRouteRef.current = searchRoute;
  const showRouteResultRef = useRef(showRouteResult);
  showRouteResultRef.current = showRouteResult;
  // The traveller's place is the default "from", filled once the origin is known and the box is still empty.
  useEffect(() => {
    if (!origin || abForm.from) return;
    setAbForm((f) => (f.from ? f : { ...f, from: originAsPlace(origin) }));
  }, [origin, abForm.from]);
  // atlas:route asks the card to search (detail: from, to, depart, nights, flex, oneWay);
  // atlas:route-result hands it an answer already computed (the chat), drawn without a fetch.
  useEffect(() => {
    const onRoute = (e: Event) => {
      const d = (e as CustomEvent<{ from?: string; to?: string; depart?: string; nights?: number; flex?: number; oneWay?: boolean }>).detail ?? {};
      if (!d.to) return;
      const base = emptyRouteForm();
      // The form as it is now (the ref), then the origin as a place the engine can resolve: "your location" is not one, its coordinates are.
      const o = originRef.current;
      const current = abFormRef.current;
      const form: RouteForm = { ...current, harder: false, from: d.from || current.from || (o ? originAsPlace(o) : ""), to: d.to, depart: d.depart && /^\d{4}-\d{2}-\d{2}$/.test(d.depart) ? d.depart : base.depart, nights: d.nights && d.nights > 0 ? d.nights : base.nights, flex: d.flex != null && d.flex >= 0 && d.flex <= 3 ? d.flex : base.flex, oneWay: d.oneWay === true || d.nights === 0 };
      if (form.from) void searchRouteRef.current(form);
      else {
        setAbForm(form);
        setRouteCard({ open: true, collapsed: false });
      }
    };
    const onRouteResult = (e: Event) => {
      const d = (e as CustomEvent<{ result?: RouteResult; option?: number }>).detail;
      if (d?.result && Array.isArray(d.result.options)) showRouteResultRef.current(d.result, d.option);
    };
    window.addEventListener("atlas:route", onRoute);
    window.addEventListener("atlas:route-result", onRouteResult);
    return () => {
      window.removeEventListener("atlas:route", onRoute);
      window.removeEventListener("atlas:route-result", onRouteResult);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // ---- The graph walk: GET /api/walk streams the search as it thinks ({node}, {edge}, {loop},
  // {progress}, {done}); the globe draws every line as it arrives and the card lists the loops.
  /** Where the traveller is and flies from, the part of every walk the asker does not have to say. */
  function walkContext(): WalkQuery | null {
    const o = originRef.current ?? origin;
    if (!o || !boardGateways.length || !gateways[0]) return null;
    // The label only names things; the engine reads the point. A city nearby reads better than "your location".
    const label = (homeCity?.city.name ?? o.label).replace(/[^\p{L}\p{N} ,.'()&-]/gu, " ").trim().slice(0, 60) || "home";
    return { g: boardGateways.map((g) => g.iata).slice(0, 4), home: gateways[0].airport.country, lat: o.lat.toFixed(3), lon: o.lon.toFixed(3), label, ...(excludeQ ? { exclude: excludeQ } : {}) };
  }
  /** The dates a walk searches when the asker gave none: the When month (from tomorrow at the earliest), else the next three weeks; always room for the longest trip. */
  function walkWindow(maxNights: number, from?: string): { from: string; to: string } {
    const tomorrow = addDays(todayIso(), 1);
    let f = from && ISO_DAY.test(from) && from > tomorrow ? from : tomorrow;
    let t = addDays(f, 21);
    if (!from && month) {
      const start = `${month}-01`;
      f = start > tomorrow ? start : tomorrow;
      const [y, m] = month.split("-").map(Number);
      t = localIso(new Date(y, m, 0));
    }
    if (daysBetween(f, t) < maxNights + 2) t = addDays(f, maxNights + 4);
    return { from: f, to: t };
  }
  /** The point the walk's HOME node stands for. */
  function walkHome(q: WalkQuery | undefined): [number, number] | null {
    if (q?.lat == null || q.lon == null) return null;
    const lat = Number(q.lat);
    const lon = Number(q.lon);
    return Number.isFinite(lat) && Number.isFinite(lon) ? [lon, lat] : null;
  }
  /** A loop's points to frame: its stops and the home point. */
  function frameWalkLoop(loop: WalkLoop | undefined, q: WalkQuery | undefined) {
    if (!loop) return;
    const pts: [number, number][] = loop.stops.map((st) => [st.lon, st.lat]);
    const h = walkHome(q);
    if (h) pts.push(h);
    // A margin on top of the panel's padding: on the globe fitBounds lands a few pixels short,
    // and a stop at the very edge loses its numbered tag to the panel or the card.
    const map = mapRef.current;
    if (!map || !pts.length) return;
    revealMap();
    const pad = panelPadding();
    const bounds = new maplibregl.LngLatBounds(pts[0], pts[0]);
    for (const x of pts) bounds.extend(x);
    const padding = fitPadding(map, { left: pad.left + 40, right: pad.right + 30, top: pad.top + 30, bottom: pad.bottom + 30 });
    map.fitBounds(bounds, { padding, maxZoom: 5.5, duration: reducedMotion() ? 0 : 1600 });
  }
  /** The edges of finished loops, for an answer that came without its stream (a memo hit, the chat's result): the best loop's legs chosen, the rest faint. */
  function edgesOfLoops(loops: WalkLoop[], q: WalkQuery | undefined): WalkEdgeView[] {
    const home = walkHome(q);
    const out: WalkEdgeView[] = [];
    const long = performance.now() - 60_000;
    loops.forEach((loop, k) => {
      const byCode = new Map(loop.stops.map((st) => [st.code, [st.lon, st.lat] as [number, number]]));
      const at = (code: string) => (code === "HOME" ? home : (byCode.get(code) ?? wildCoord(code)));
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
  /**
   * Runs a walk and draws it live. given: any of the /api/walk parameters; what is missing
   * comes from where the traveller is (airports, home country, point, Been list) and the
   * When window. A newer walk stops the older one, so it spends no more live searches.
   */
  async function runWalk(given: WalkQuery, source: WalkSource) {
    const ctx = walkContext();
    const q: WalkQuery = { ...(ctx ?? {}) };
    for (const k of WALK_PARAM_KEYS) {
      const v = given[k];
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
      q[k] = v;
    }
    // The Been list and the asker's own exclusions both hold.
    if (ctx?.exclude && given.exclude) q.exclude = [...new Set([...String(ctx.exclude).split(","), ...(Array.isArray(given.exclude) ? given.exclude : String(given.exclude).split(","))])].filter(Boolean).join(",");
    if (!q.g || !q.home || q.lat == null || q.lon == null) {
      setNotice("Your airports are still loading; try the walk again in a moment.");
      return;
    }
    const maxN = Number(q.maxNights ?? q.minNights ?? 6) || 6;
    // Only "Back by" given: that date holds, and the window opens early enough for the longest trip.
    const tomorrow = addDays(todayIso(), 1);
    if (!q.from && q.to && ISO_DAY.test(String(q.to)) && String(q.to) > tomorrow) {
      const early = addDays(String(q.to), -(maxN + 4));
      q.from = early > tomorrow ? early : tomorrow;
    }
    if (!q.from || !q.to || !ISO_DAY.test(String(q.from)) || !ISO_DAY.test(String(q.to))) {
      const w = walkWindow(maxN, typeof q.from === "string" ? q.from : undefined);
      q.from = w.from;
      q.to = w.to;
    }
    walkCtrl.current?.abort();
    const ctrl = new AbortController();
    walkCtrl.current = ctrl;
    const stale = () => walkCtrl.current !== ctrl;
    const { home, toHome } = startWalkStage(q, source);
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
          const picked = walkPickedRef.current ? loops.findIndex((x) => x.id === walkPickedRef.current) : -1;
          return { ...w, status: "ok", result: r, loops, selected: picked >= 0 ? picked : 0, edges: w.edges.length ? w.edges : edgesOfLoops(loops, q) };
        });
        window.clearTimeout(toHome);
        if (!walkPickedRef.current) frameWalkLoop(r.loops[0], q);
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
  /**
   * The walk takes the stage: an itinerary in front closes, the route card folds, the walk
   * state starts over for this question, and the camera comes to the door. Shared by the
   * walk itself and by a Wild build on the walk engine, whose stream carries the same events.
   */
  function startWalkStage(q: WalkQuery, source: WalkSource): { home: [number, number] | null; toHome: number } {
    if (itin) closeItinerary();
    setRouteCard((c) => (c.open && !c.collapsed ? { ...c, collapsed: true } : c));
    if (!isPhone()) cardOpenRef.current = true;
    else if (sheetRef.current !== "peek") {
      sheetRef.current = "peek";
      setSheet("peek");
    }
    walkNodesRef.current = new Map();
    walkPickedRef.current = null;
    const home = walkHome(q);
    if (home) walkNodesRef.current.set("HOME", { p: home, money: 0 });
    setWalk({ ...EMPTY_WALK, status: "loading", params: q, source, open: true });
    setWalkClock(performance.now());
    // The fan-out from home is the first thing to see: the camera comes to the door, zoomed out enough for a continent.
    const map = mapRef.current;
    let toHome = 0;
    if (map && home) {
      spinRef.current = false;
      // A frame later, so the card has rendered and the padding keeps the fan-out clear of it.
      // An answer from the memo can land before that: its own framing cancels this one.
      toHome = window.setTimeout(() => map.flyTo({ center: home, zoom: isPhone() ? 2.4 : 3.3, duration: reducedMotion() ? 0 : 1400, padding: panelPadding(), essential: true }), 60);
    }
    return { home, toHome };
  }
  /** Draws one streamed line of a walk (its progress, a node, an edge, a loop) into the walk state; done and error are the caller's. */
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
        const a = walkNodesRef.current.get(e.from)?.p ?? (e.from === "HOME" ? home : wildCoord(e.from));
        const b: [number, number] = [e.lon, e.lat];
        if (a && Number.isFinite(e.lat) && Number.isFinite(e.lon) && !(e.lat === 0 && e.lon === 0)) {
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
          const picked = walkPickedRef.current ? loops.findIndex((x) => x.id === walkPickedRef.current) : -1;
          return { ...w, loops, selected: picked >= 0 ? picked : 0 };
        });
      }
    };
  }
  /** Stop the walk where it is: what it found stays on the globe. */
  function cancelWalk() {
    walkCtrl.current?.abort();
    walkCtrl.current = null;
    setWalk((w) => (w.status === "loading" ? { ...w, status: w.loops.length ? "ok" : "error", note: w.loops.length ? undefined : "Stopped." } : w));
  }
  function closeWalk() {
    walkCtrl.current?.abort();
    walkCtrl.current = null;
    setWalk(EMPTY_WALK);
  }
  function selectWalkLoop(i: number) {
    const loop = walk.loops[i];
    if (!loop) return;
    walkPickedRef.current = loop.id;
    setWalk((w) => ({ ...w, selected: i, collapsed: false }));
    setRouteCard((c) => (c.open && !c.collapsed ? { ...c, collapsed: true } : c));
    frameWalkLoop(loop, walk.params);
  }
  /** A finished walk handed over (the chat): drawn without a search. */
  function showWalkResult(r: WalkResult, params?: WalkQuery) {
    walkCtrl.current?.abort();
    walkCtrl.current = null;
    walkPickedRef.current = null;
    const q: WalkQuery = { ...(walkContext() ?? {}), ...(params ?? {}) };
    if (itin) closeItinerary();
    setRouteCard((c) => (c.open && !c.collapsed ? { ...c, collapsed: true } : c));
    if (!isPhone()) cardOpenRef.current = true;
    setWalk({ ...EMPTY_WALK, status: "ok", params: q, source: "event", result: r, loops: r.loops, edges: edgesOfLoops(r.loops, q), open: true });
    frameWalkLoop(r.loops[0], q);
  }
  /** The walk's origin as an itinerary place: the traveller's own when it is the same point. */
  function walkOriginPlace(q: WalkQuery | undefined): ItinPlace | undefined {
    const h = walkHome(q);
    if (!h) return originPlace;
    if (originPlace && Math.abs(originPlace.lat - h[1]) < 0.01 && Math.abs(originPlace.lon - h[0]) < 0.01) return originPlace;
    return { name: String(q?.label ?? "home"), lat: h[1], lon: h[0] };
  }
  /**
   * The trip style as walk parameters: nights a stop, the tradeoff, "unique" for the unusual,
   * the avoid list and the longest ground hop (0 when trains and coaches are not wanted). A
   * builder lays its own form over these; the command line fills only what the words left out.
   */
  function prefsWalk(p: Prefs = prefs): WalkQuery {
    const pq = prefsQuery(p);
    const q: WalkQuery = { nightsPerStop: pq.nightsPerStop, tradeoff: pq.tradeoff, ground: pq.ground };
    if (pq.style) q.style = pq.style;
    if (p.avoid.length) q.avoid = p.avoid;
    return q;
  }
  /** Short loops' Smart loop: the form in TripsExtra.smart as a walk, over the trip style. */
  function runSmartLoop() {
    const f = tripsExtra.smart;
    const base = prefsWalk();
    // The form's style chips mix two settings: Cheapest is the price tradeoff, Unique the taste
    // (with the trip style's tradeoff), Balanced both even. The trip style's avoid list holds
    // on top of the form's own picks.
    // Balanced carries Comfort too: the form has no Comfort chip, so a Comfort trip style shows as
    // Balanced and runs as comfort (a price style shows as Cheapest instead).
    const tradeoff = f.style === "cheapest" ? "price" : f.style === "unique" || prefs.tradeoff === "comfort" ? prefs.tradeoff : "balanced";
    const formAvoid = f.avoidLike ? f.avoid.map((c) => `like:${c}`) : f.avoid;
    void runWalk(
      {
        ...base,
        minNights: f.minNights,
        maxNights: f.maxNights,
        // The trip style's chip sends its exact range ("2-2" is two nights, never three); a chip picked here reads as typed.
        nightsPerStop: f.perStop === nightsParam(prefs) ? nightsRangeParam(prefs.nightsPerPlace) : f.perStop,
        maxStops: f.cities,
        tradeoff,
        style: f.style === "unique" ? "unique" : undefined,
        // "like:DE" asks the engine for Germany's whole group (Austria, Switzerland), the owner's "countries like Germany".
        avoid: [...new Set([...formAvoid, ...prefs.avoid])],
        mustInclude: f.mustInclude,
        budget: f.budget,
        ...(f.from ? { from: f.from } : {}),
        ...(f.to ? { to: f.to } : {}),
      },
      "short",
    );
  }
  /**
   * The command line's walk (the brain's 'walk' command kind): any field named like a walk
   * parameter is used, dates only when they are dates (a route's "from" is a place), and the
   * traveller's own context fills the rest. Its label is the command's display text, never
   * the walk's place name.
   */
  function walkFromCommand(c: Record<string, unknown>) {
    const q: WalkQuery = {};
    const skip = new Set<string>(["g", "home", "lat", "lon", "label", "exclude"]);
    for (const k of WALK_PARAM_KEYS) {
      if (skip.has(k)) continue;
      const v = c[k];
      if (typeof v === "number" || (typeof v === "string" && v.trim())) q[k] = v;
      else if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) q[k] = v as string[];
      // A range of nights a stop arrives as [2, 3]; the route reads "2-3".
      else if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number")) q[k] = v[0] === v[1] ? v[0] : `${v[0]}-${v[1]}`;
    }
    if (q.from && !ISO_DAY.test(String(q.from))) delete q.from;
    if (q.to && !ISO_DAY.test(String(q.to))) delete q.to;
    // Ground arrives in minutes (480 for "only trains between cities", 0 for "flights only"); an older
    // parser sent the words, read here the same way. A pace typed alone already arrives as its nights a stop.
    if (c.ground === "prefer") q.ground = 480;
    else if (c.ground === "none") q.ground = 0;
    else if (q.ground != null && !Number.isFinite(Number(q.ground))) delete q.ground;
    // Other names a command may use for the same things.
    const num = (k: string) => (typeof c[k] === "number" ? (c[k] as number) : undefined);
    const nights = num("nights");
    if (q.minNights == null && nights) q.minNights = nights;
    if (q.maxNights == null && nights) q.maxNights = nights;
    const stops = num("stops");
    if (q.maxStops == null && stops) q.maxStops = stops;
    if (q.mustInclude == null && Array.isArray(c.cities)) q.mustInclude = (c.cities as unknown[]).filter((x): x is string => typeof x === "string");
    if (!q.from && typeof c.start === "string" && ISO_DAY.test(c.start)) q.from = c.start;
    if (!q.to && typeof c.end === "string" && ISO_DAY.test(c.end)) q.to = c.end;
    // What the words left out comes from the trip style ("loop 6 days" stays 2 to 3 nights a
    // stop); an avoid list in the words adds to the style's own.
    const style = prefsWalk();
    for (const k of Object.keys(style) as (keyof WalkQuery)[]) {
      if (k === "avoid" && q.avoid != null) q.avoid = [...new Set([...(Array.isArray(q.avoid) ? q.avoid : String(q.avoid).split(",")), ...prefs.avoid])];
      else if (q[k] == null) q[k] = style[k];
    }
    // "loop from Cluj": a named start is placed through the city table, with the airports near it.
    const named = typeof c.origin === "string" ? c.origin.trim() : "";
    if (named && foldName(named) !== foldName(homeCity?.city.name ?? origin?.label ?? "")) {
      const start = cityByName(named);
      if (start) {
        const near = nearestGateways(airports, start.lat, start.lon).filter((g) => g.km <= 250);
        const real = near.filter((g) => g.airport.size !== "small");
        const g = (real.length ? real : near).slice(0, 3).map((x) => x.airport.iata);
        if (g.length) Object.assign(q, { g, home: start.country, lat: start.lat.toFixed(3), lon: start.lon.toFixed(3), label: start.name });
      } else setNotice(`${named} is not on the map; the loop starts from where you are.`);
    }
    clearFront();
    // Through the window event, the same door the chat uses: the globe draws it as it thinks.
    window.dispatchEvent(new CustomEvent("atlas:walk", { detail: { params: { ...(walkContext() ?? {}), ...q } } }));
  }
  /**
   * A named start in the city table, or null. The same order lib/agent-tools.ts uses: the exact
   * name, then a code written in capitals ("GDN"), then a whole leading word of the name ("Cluj"
   * finds Cluj-Napoca), then a code in any case. cities.json carries no population, so several
   * cities of one name (London, Ontario; Birmingham, Alabama) are told apart by how many routes
   * leave their airports, with a lead for the traveller's own country and their part of the
   * world: someone in Brasov saying "London" means the English one.
   */
  function cityByName(name: string): City | null {
    const raw = name.trim();
    const q = foldName(raw);
    if (!q) return null;
    const list = Object.entries(cities);
    const o = originRef.current ?? origin;
    const homeCountry = gateways[0]?.airport.country;
    const weight = (c: City) => {
      let w = 0;
      for (const a of c.airports) w = Math.max(w, routesFrom.get(a)?.length ?? (byIata.get(a)?.size === "large" ? 30 : byIata.get(a)?.size === "medium" ? 10 : 0));
      if (homeCountry && c.country === homeCountry) w += 1000;
      else if (o && haversineKm(o.lat, o.lon, c.lat, c.lon) < 3500) w += 300;
      return w;
    };
    const pick = (hits: [string, City][]) => (hits.length ? hits.reduce((b, x) => (weight(x[1]) > weight(b[1]) ? x : b))[1] : null);
    const byCode = (code: string) => cities[code] ?? list.find(([, c]) => c.airports.includes(code))?.[1] ?? null;
    const exact = pick(list.filter(([, c]) => foldName(c.name) === q));
    if (exact) return exact;
    if (/^[A-Z]{3}$/.test(raw)) {
      const hit = byCode(raw);
      if (hit) return hit;
    }
    if (q.length >= 4) {
      const leading = pick(list.filter(([, c]) => {
        const n = foldName(c.name);
        return n.startsWith(q) && !/[a-z0-9]/.test(n.charAt(q.length));
      }));
      if (leading) return leading;
    }
    return /^[a-z]{3}$/i.test(raw) ? byCode(raw.toUpperCase()) : null;
  }
  const runWalkRef = useRef(runWalk);
  runWalkRef.current = runWalk;
  const showWalkResultRef = useRef(showWalkResult);
  showWalkResultRef.current = showWalkResult;
  // atlas:walk {params} runs a walk and draws it live; atlas:walk-result {result, params?} draws a finished one.
  useEffect(() => {
    const onWalk = (e: Event) => {
      const d = (e as CustomEvent<{ params?: WalkQuery }>).detail;
      void runWalkRef.current(d?.params && typeof d.params === "object" ? d.params : {}, "event");
    };
    const onWalkResult = (e: Event) => {
      const d = (e as CustomEvent<{ result?: WalkResult; params?: WalkQuery }>).detail;
      if (d?.result && Array.isArray(d.result.loops)) showWalkResultRef.current(d.result, d.params);
    };
    window.addEventListener("atlas:walk", onWalk);
    window.addEventListener("atlas:walk-result", onWalkResult);
    return () => {
      window.removeEventListener("atlas:walk", onWalk);
      window.removeEventListener("atlas:walk-result", onWalkResult);
    };
  }, []);
  // The tags that come and go need a clock while the stream runs, and one last tick after it ends to clear them.
  useEffect(() => {
    if (walk.status !== "loading") {
      const t = window.setTimeout(() => setWalkClock(performance.now()), EDGE_TAG_MS + 200);
      return () => window.clearTimeout(t);
    }
    const id = window.setInterval(() => setWalkClock(performance.now()), 600);
    return () => window.clearInterval(id);
  }, [walk.status]);
  // What the animation loop draws: the edges split by kind, the nodes while the walk runs, and the best loop's legs (the rest dims once it is done).
  useEffect(() => {
    if (!walkShowing || !walk.edges.length) {
      walkDrawRef.current = null;
      return;
    }
    const best = walk.loops[walk.selected];
    // Streamed edges run between city codes (ROM, WAW) and HOME, a loop's legs between airports
    // (FCO, WMI): both spellings are keyed, so the best loop's first hop and way home stay lit.
    const bestKeys = new Set((best?.legs ?? []).map((l) => `${l.from}>${l.to}`));
    if (best?.stops.length) {
      const chain = ["HOME", ...best.stops.map((st) => st.code), "HOME"];
      for (let i = 1; i < chain.length; i++) bestKeys.add(`${chain[i - 1]}>${chain[i]}`);
    }
    walkDrawRef.current = { fly: walk.edges.filter((e) => e.kind === "fly"), ground: walk.edges.filter((e) => e.kind !== "fly"), nodes: walk.status === "loading" ? walk.nodes : [], done: walk.status !== "loading", best: bestKeys, v: (walkDrawRef.current?.v ?? 0) + 1 };
  }, [walkShowing, walk.edges, walk.nodes, walk.status, walk.loops, walk.selected]);

  // The option on show, as legs with coordinates: an airport by code, a city by code, the two
  // ends by the engine's own coordinates, a station by the coordinates the engine may attach;
  // a leg whose end is unknown continues from the last known point so the line never breaks.
  const abOption: RouteOption | null = abShowing && abSelected != null ? (ab.options[abSelected] ?? null) : null;
  /** An option's legs with coordinates (r: the answer it belongs to, for the two ends; absent while the stream runs). */
  const optionLegs = useCallback(
    (o: RouteOption, r: RouteResult | undefined): RouteLeg[] => {
      const ends = new Map<string, [number, number]>();
      if (r) {
        ends.set(r.from.label, [r.from.lon, r.from.lat]);
        ends.set(r.to.label, [r.to.lon, r.to.lat]);
        for (const code of r.from.airports) if (!byIata.has(code)) ends.set(code, [r.from.lon, r.from.lat]);
        for (const code of r.to.airports) if (!byIata.has(code)) ends.set(code, [r.to.lon, r.to.lat]);
      }
      const at = (code: string, name: string, lat?: number, lon?: number): [number, number] | null => {
        if (lat != null && lon != null) return [lon, lat];
        return wildCoord(code) ?? ends.get(code) ?? ends.get(name) ?? null;
      };
      const out: RouteLeg[] = [];
      let last: [number, number] | null = null;
      const legs: AbLeg[] = [...o.legs, ...(o.back ?? [])];
      legs.forEach((l, i) => {
        const from = at(l.from, l.fromName, l.fromLat, l.fromLon) ?? last ?? (i === 0 && r ? [r.from.lon, r.from.lat] : null);
        const to = at(l.to, l.toName, l.toLat, l.toLon) ?? (i === o.legs.length - 1 && r ? [r.to.lon, r.to.lat] : null);
        if (from && to) {
          out.push({ from, to, kind: l.kind === "fly" ? "fly" : "ground" });
          last = to;
        }
      });
      return out;
    },
    [byIata, wildCoord],
  );
  const abLegs = useMemo<RouteLeg[]>(() => (abOption ? optionLegs(abOption, ab.result) : []), [abOption, ab.result, optionLegs]);
  // While the card searches, every option drawn as it arrives (faint), the one picked at the end drawn bold.
  const abStreamLegs = useMemo<RouteLeg[]>(() => (abShowing && ab.status === "loading" ? ab.options.slice(0, 24).flatMap((o) => optionLegs(o, ab.result)) : []), [abShowing, ab.status, ab.options, ab.result, optionLegs]);
  const abPoints = useMemo<[number, number][]>(() => {
    const pts: [number, number][] = [];
    for (const l of abLegs) {
      if (!pts.length) pts.push(l.from);
      pts.push(l.to);
    }
    return pts;
  }, [abLegs]);

  /** A point for an itinerary place: its own coordinates, else its code on the map (the converters leave 0,0 for the server to fill). */
  const placeCoord = useCallback(
    (pl: ItinPlace): [number, number] | null => {
      if (Number.isFinite(pl.lat) && Number.isFinite(pl.lon) && !(pl.lat === 0 && pl.lon === 0)) return [pl.lon, pl.lat];
      return pl.code ? wildCoord(pl.code) : null;
    },
    [wildCoord],
  );
  // ---- The itinerary on the globe: its stops numbered, flights as arcs, ground as lines.
  // Every point goes through placeCoord: a place the converters left at 0,0 is found by its
  // code, and one nobody can place is left out rather than drawn at null island (the server's
  // normalised skeleton replaces the shape when it arrives; a refused plan never does).
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
  const itinPoints = useMemo<[number, number][]>(() => (itinRoute ? itinRoute.stops.map((st) => [st.lon, st.lat] as [number, number]) : []), [itinRoute]);
  // The legs and points the overlay layers draw: the itinerary's, else the route card's.
  // ---- The walk's loop on show, through the same mechanism as a trip: numbered stops, legs
  // drawn from coordinates (HOME is the walk's own point), the trail running along them.
  const walkLoop = walkShowing ? (walk.loops[walk.selected] ?? null) : null;
  const walkRoute = useMemo<{ stops: WildStop[]; legs: RouteLeg[]; points: [number, number][]; home: [number, number] | null } | null>(() => {
    if (!walkLoop) return null;
    const home = walkHome(walk.params);
    const byCode = new Map(walkLoop.stops.map((st) => [st.code, [st.lon, st.lat] as [number, number]]));
    const at = (code: string) => (code === "HOME" ? home : (byCode.get(code) ?? wildCoord(code)));
    const legs: RouteLeg[] = [];
    for (const l of walkLoop.legs) {
      const a = at(l.from);
      const b = at(l.to);
      if (a && b) legs.push({ from: a, to: b, kind: l.kind === "fly" ? "fly" : "ground" });
    }
    const stops: WildStop[] = walkLoop.stops.map((st) => ({ code: st.code, name: st.name, country: st.country, lat: st.lat, lon: st.lon, arrive: st.arrive, depart: st.leave, nights: st.nights, perDay: 0 }));
    const points: [number, number][] = [...stops.map((st) => [st.lon, st.lat] as [number, number]), ...(home ? [home] : [])];
    return { stops, legs, points, home };
    // walkHome only reads its argument.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walkLoop, walk.params, wildCoord]);
  // The legs and points the overlay layers draw: the itinerary's, else the walk's loop, else the route card's.
  const overlayLegs = itinRoute ? itinRoute.legs : walkRoute ? walkRoute.legs : abLegs;
  const overlayPoints = itinRoute ? itinPoints : walkRoute ? walkRoute.points : abPoints;

  // ---- Where the traveller is, as the capabilities need it: a place /api/route resolves
  // (a city name when one is close, else the coordinates) and an itinerary's origin.
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
  const fromPlace = origin ? (homeCity ? homeCity.city.name : originAsPlace(origin)) : "";
  const originPlace = useMemo<ItinPlace | undefined>(() => (origin ? { name: homeCity?.city.name ?? origin.label, ...(homeCity ? { code: homeCity.code, country: homeCity.city.country } : {}), lat: origin.lat, lon: origin.lon } : undefined), [origin, homeCity]);

  // ---- What reaching each event costs: one /api/purpose call per gateway set with live=0 (the
  // stored boards only, zero Kiwi searches), so the Events list, the event card, "Worth flying
  // for here" and event itineraries carry a fare wherever one is known.
  const yearOut = useMemo(() => localIso(new Date(Date.now() + 365 * 86_400_000)), []);
  const fareGateways = boardGateways.map((g) => g.iata).slice(0, 4).join(",");
  const [eventFares, setEventFares] = useState<Map<string, { start: string; end: string; deal: Deal }[]>>(() => new Map());
  useEffect(() => {
    if (!fareGateways) return;
    const ctrl = new AbortController();
    const q = new URLSearchParams({ g: fareGateways, from: todayIso(), to: yearOut, live: "0" });
    if (excludeQ) q.set("exclude", excludeQ);
    fetch(`/api/purpose?${q}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { trips?: { event: { name: string; start: string; end: string }; deal: Deal | null }[] } | null) => {
        const m = new Map<string, { start: string; end: string; deal: Deal }[]>();
        for (const t of j?.trips ?? []) if (t.deal) m.set(t.event.name, [...(m.get(t.event.name) ?? []), { start: t.event.start, end: t.event.end, deal: t.deal }]);
        setEventFares(m);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [fareGateways, excludeQ, yearOut]);
  /** The event with its stored fare: the same edition first, else a fare whose dates overlap it; never a fare already gone. */
  const withFare = useCallback(
    (e: EventSpot): EventSpot => {
      const tomorrow = localIso(new Date(Date.now() + 86_400_000));
      const list = (eventFares.get(e.name) ?? []).filter((x) => x.deal.out >= tomorrow);
      const hit = list.find((x) => x.start === e.start) ?? list.find((x) => x.deal.out <= e.end && x.deal.back >= e.start);
      return hit ? { ...e, deal: hit.deal } : e;
    },
    [eventFares],
  );
  // The stored boards rarely reach months ahead, so most events start unpriced. "Price the
  // nearest live" on the list spends up to four Kiwi searches (the old Purpose mode's budget)
  // on the nearest events in the window without a fare, and merges what it finds.
  const [faresLive, setFaresLive] = useState<{ status: "idle" | "loading" | "done"; searched?: number; note?: string }>({ status: "idle" });

  // ---- Events worth flying for, as a layer: the When window (or the next four months), the
  // Been rules applied, optional words ("jazz") and a country from the command line.
  const evWindow = useMemo(() => {
    if (evLayer.from && evLayer.to) return { from: evLayer.from, to: evLayer.to };
    if (month) return { from: `${month}-01`, to: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10) };
    return { from: todayIso(), to: localIso(new Date(Date.now() + 120 * 86_400_000)) };
  }, [evLayer.from, evLayer.to, month]);
  const eventSpots = useMemo<EventSpot[]>(() => {
    if (!evLayer.on) return [];
    // Every word must match (AND): "jazz festivals" is a jazz festival, not every festival.
    // A kind word ("festivals", "music") matches the event's kind or its name; any other word
    // matches its name, city, kind or why. Each word is tried as typed and without a plural s.
    const words = (evLayer.words ?? []).map(foldName).filter((w) => w.length >= 2).map((w) => [w, w.replace(/s$/, "")]);
    const isKind = (ws: string[]) => ws.some((w) => EVENT_KINDS.has(w));
    const matches = (e: EventSpot, ws: string[]) => {
      const fields = isKind(ws) ? [e.name, e.kind] : [e.name, e.cityName, e.kind, e.why ?? ""];
      return ws.some((w) => fields.some((f) => foldName(f).includes(w)));
    };
    const seen = new Set<string>();
    return (eventsInWindow(evWindow.from, evWindow.to) as unknown as RawEvent[])
      .map((e) => toEventSpot(e, cities))
      .filter((e): e is EventSpot => !!e && countryAllowed(e.country, exclude) && (!evLayer.country || e.country === evLayer.country))
      .filter((e) => words.every((ws) => matches(e, ws)))
      .filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true)))
      .map(withFare)
      .sort((a, b) => a.start.localeCompare(b.start));
  }, [evLayer.on, evLayer.words, evLayer.country, evWindow, cities, exclude, withFare]);
  useEffect(() => setFaresLive({ status: "idle" }), [evWindow.from, evWindow.to, fareGateways]);
  async function priceEventsLive() {
    if (!fareGateways || faresLive.status === "loading") return;
    setFaresLive({ status: "loading" });
    const q = new URLSearchParams({ g: fareGateways, from: evWindow.from, to: evWindow.to, live: "4" });
    if (evLayer.words?.length) q.set("kinds", evLayer.words.join(","));
    if (excludeQ) q.set("exclude", excludeQ);
    try {
      const r = await fetch(`/api/purpose?${q}`);
      const j = (await r.json().catch(() => ({}))) as { trips?: { event: { name: string; start: string; end: string }; deal: Deal | null }[]; searched?: number; note?: string; error?: string };
      if (!r.ok) {
        setFaresLive({ status: "done", note: j.error ?? `the pricing failed (${r.status})` });
        return;
      }
      setEventFares((m) => {
        const next = new Map(m);
        for (const t of j.trips ?? []) {
          if (!t.deal) continue;
          const list = next.get(t.event.name) ?? [];
          if (!list.some((x) => x.start === t.event.start)) next.set(t.event.name, [...list, { start: t.event.start, end: t.event.end, deal: t.deal }]);
        }
        return next;
      });
      setFaresLive({ status: "done", searched: j.searched ?? 0, note: j.note });
    } catch {
      setFaresLive({ status: "done", note: "Could not reach the event pricing." });
    }
  }
  function selectEvent(e: EventSpot) {
    setEventSel(e);
    if (!isPhone()) cardOpenRef.current = true;
    else {
      if (sheetRef.current !== "peek") {
        sheetRef.current = "peek";
        setSheet("peek");
      }
      setRouteCard((c) => (c.open ? { open: true, collapsed: true } : c));
    }
    spinRef.current = false;
    revealMap();
    mapRef.current?.flyTo({ center: [e.lon, e.lat], zoom: Math.max(4.2, Math.min(5.5, mapRef.current.getZoom() + 1)), duration: 1400, padding: panelPadding() });
  }
  function toggleEvents() {
    if (evLayer.on) {
      setEvLayer({ on: false, from: "", to: "", list: false });
      setEventSel(null);
      return;
    }
    setEvLayer({ on: true, from: "", to: "", list: true });
    // A phone has room for one card above the sheet: the route card folds while the events show.
    if (isPhone()) {
      if (routeCard.open) setRouteCard({ open: true, collapsed: true });
      // The markers are the point: the sheet drops to a peek so the globe shows.
      sheetRef.current = "peek";
      setSheet("peek");
    }
    spinRef.current = false;
    mapRef.current?.flyTo({ center: [origin?.lon ?? 20, Math.max(-20, Math.min(45, origin?.lat ?? 30))], zoom: isPhone() ? 1.1 : 1.5, duration: 1500, essential: true });
  }
  // A deal's badge and a place's list read the curated table in the browser: no fetch.
  const eventCache = useMemo(() => new Map<string, EventSpot | null>(), [exclude, cities]); // eslint-disable-line react-hooks/exhaustive-deps
  const eventOf = useCallback(
    (d: Deal): EventSpot | null => {
      const k = `${d.dstCity}|${d.out}|${d.back}`;
      if (!eventCache.has(k)) eventCache.set(k, d.out && d.back ? (eventsHere({ code: d.dstCity }, d.out, d.back, exclude, cities)[0] ?? null) : null);
      return eventCache.get(k) ?? null;
    },
    [eventCache, exclude, cities],
  );
  const eventsAtPlace = useCallback((q: { code?: string; country?: string; lat: number; lon: number }) => eventsHere({ code: q.code, country: q.country, lat: q.lat || undefined, lon: q.lon || undefined, km: 60 }, todayIso(), yearOut, exclude, cities).map(withFare), [yearOut, exclude, cities, withFare]);

  // ---- Place pages from anywhere: atlas:place {name?, code?}, the command line, an event's city.
  function openPlace(q: { name?: string; code?: string }) {
    const code = q.code?.trim().toUpperCase();
    let hit: { code?: string; name: string; country?: string; lat: number; lon: number } | null = null;
    if (code && cities[code]) hit = { code, ...cities[code] };
    if (!hit && q.name) {
      const n = foldName(q.name);
      let bestPop = -1;
      for (const [k, c] of Object.entries(cities)) {
        const f = foldName(c.name);
        const score = f === n ? 2 : f.startsWith(n) && n.length >= 3 ? 1 : 0;
        if (!score) continue;
        const rank = score * 1e9 + (c.pop ?? 0);
        if (rank > bestPop) {
          bestPop = rank;
          hit = { code: k, ...c };
        }
      }
    }
    if (!hit) {
      const a = code ? byIata.get(code) : q.name ? airports.find((x) => foldName(x.city ?? "") === foldName(q.name!)) : undefined;
      if (a) hit = { code: cityOf.get(a.iata), name: a.city ?? a.name, country: a.country, lat: a.lat, lon: a.lon };
    }
    if (!hit) {
      setNotice(`No place called "${q.name ?? q.code}" on the map yet. Try the nearest city.`);
      return;
    }
    setPlacePage({ name: hit.name, code: hit.code, country: hit.country, lat: hit.lat, lon: hit.lon });
    setSightsOnMap(false);
    if (isPhone() && sheetRef.current === "peek") setSheet("half");
    spinRef.current = false;
    revealMap();
    mapRef.current?.flyTo({ center: [hit.lon, hit.lat], zoom: 5.5, duration: 1500, padding: panelPadding() });
  }
  const openPlaceRef = useRef(openPlace);
  openPlaceRef.current = openPlace;

  // ---- Itineraries: every result can become one; the view sits in front of the panel.
  function frameShape(sh: Skeleton | Itin) {
    const pts = sh.stops.map(placeCoord).filter((c): c is [number, number] => !!c);
    const home = placeCoord(sh.origin);
    if (home && pts.length && sh.stops.length < 6) pts.push(home);
    framePoints(pts, 6);
  }
  function openItinerary(o0: Omit<ItinOpen, "n">) {
    // The planner writes at most 60 days: a longer stay or loop is planned for its first four
    // weeks (the title says so) rather than sent and refused.
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
  /**
   * A route answer as an itinerary: ground-only legs carry no dates, so a skeleton built from
   * one can come back undated; the question's own day and nights fill it in.
   */
  function routeSkeleton(r: RouteResult, k: number): Skeleton {
    const sk = skeletonFromRoute(r, k);
    const q = ab.query ?? abForm;
    if (/^\d{4}-\d{2}-\d{2}$/.test(sk.start) || !sk.stops.length || !q.depart) return sk;
    const leave = q.oneWay ? q.depart : addDays(q.depart, q.nights);
    const nights = q.oneWay ? 0 : q.nights;
    const stops = sk.stops.map((st, i) => (i === 0 ? { ...st, arrive: q.depart, leave, nights } : st));
    // Dated by position: every leg before the first one leaving the stop is the way out (a
    // train then a coach both run on the first day); that leg and the rest are the way back.
    const dest = sk.stops[0];
    const firstBack = sk.legs.findIndex((l) => sameSpot(l.from, dest));
    const legs = sk.legs.map((l, i) => (l.date ? l : { ...l, date: firstBack < 0 || i < firstBack ? q.depart : leave }));
    return { ...sk, start: q.depart, end: leave, nights, stops, legs };
  }
  function eventSkeleton(e: EventSpot): Skeleton {
    // An event already running is planned from tomorrow, never from its first day (gone by
    // now): the converter arrives the day before a short event and on the first day of a long
    // one, so `from` is set to make that arrival tomorrow. The stored fare goes along only
    // when it leaves after today.
    const tomorrow = localIso(new Date(Date.now() + 86_400_000));
    const from = e.start >= tomorrow ? e.start : daysBetween(tomorrow, e.end) > 5 ? tomorrow : addDays(tomorrow, 1);
    const to = e.end < from ? from : e.end;
    const deal = e.deal && e.deal.out >= tomorrow ? e.deal : null;
    return skeletonFromEvent({ name: e.name, city: e.cityName, country: e.country, lat: e.lat, lon: e.lon, from, to, deal }, originPlace);
  }
  /** A few nights at a place page's city, two weeks out (or the start of the When month, when that is later). */
  function placeSkeleton(pl: { name: string; code?: string; country?: string; lat: number; lon: number }, nights = 3): Skeleton | null {
    const home = originPlace;
    if (!home) return null;
    const soon = localIso(new Date(Date.now() + 14 * 86_400_000));
    const start = month && `${month}-01` > soon ? `${month}-01` : soon;
    const here: ItinPlace = { name: pl.name, ...(pl.code ? { code: pl.code } : {}), ...(pl.country ? { country: pl.country } : {}), lat: pl.lat, lon: pl.lon };
    return chainSkeleton(home, [{ pl: here, nights }], start);
  }
  /** The skeleton of whatever result is on show, for "/itinerary": the open place page, event, route, deal or trip. */
  function shownSkeleton(): Skeleton | null {
    // The place page sits in front of everything else in the panel, so it is what the traveller is looking at.
    if (placePage) return placeSkeleton(placePage);
    const wl = walkShowing ? walk.loops[walk.selected] : undefined;
    const wo = walkOriginPlace(walk.params);
    if (wl && wo) return skeletonFromWalk(wl, wo);
    if (eventSel) return eventSkeleton(eventSel);
    if (cardShown && ab.result && abSelected != null) {
      const o = ab.options[abSelected];
      const k = o ? ab.result.options.findIndex((x) => optionKey(x) === optionKey(o)) : -1;
      if (k >= 0) return routeSkeleton(ab.result, k);
    }
    if (view === "deals" && deal) return skeletonFromDeal(deal, originPlace);
    if (view === "trips") {
      if (tripMode === "short" && trip) return skeletonFromTrip(trip, originPlace);
      if (tripMode === "wild" && wild.trip) return skeletonFromWild(wild.trip);
      const base = tripMode === "longstay" && selectedBase ? longStay.result?.bases.find((b) => b.code === selectedBase) : undefined;
      if (base) return skeletonFromLongStay(base, originPlace);
      const opt = tripMode === "group" && selectedOption != null ? group.result?.options[selectedOption] : undefined;
      if (opt) return skeletonFromGroup(opt, 0);
    }
    if (view === "chat" && chatTrip) return skeletonFromWild(chatTrip);
    return null;
  }
  /** "itinerary Lisbon 3 nights, Porto 2 nights from 14 Nov": the stops placed through the city table, legs unpriced (the itinerary prices what it can). */
  function customSkeleton(stops: { place: string; nights: number }[], start?: string, from?: string): Skeleton | null {
    const find = (name: string): ItinPlace | null => {
      const n = foldName(name);
      let best: ItinPlace | null = null;
      let pop = -1;
      for (const [code, c] of Object.entries(cities)) {
        if (foldName(c.name) !== n) continue;
        if ((c.pop ?? 0) > pop) {
          pop = c.pop ?? 0;
          best = { name: c.name, code, country: c.country, lat: c.lat, lon: c.lon };
        }
      }
      return best;
    };
    const home = (from ? find(from) : null) ?? originPlace;
    if (!home) return null;
    const found = stops.map((st) => ({ pl: find(st.place), nights: st.nights })).filter((x): x is { pl: ItinPlace; nights: number } => !!x.pl);
    return chainSkeleton(home, found, start && /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : localIso(new Date(Date.now() + 14 * 86_400_000)));
  }
  /** Placed stops in order from home and back, legs unpriced: a flight past 600 km, else a train. */
  function chainSkeleton(home: ItinPlace, stops: { pl: ItinPlace; nights: number }[], start: string): Skeleton | null {
    let day = start;
    const placed: Skeleton["stops"] = [];
    for (const st of stops) {
      const leave = addDays(day, Math.max(1, st.nights));
      placed.push({ ...st.pl, arrive: day, leave, nights: Math.max(1, st.nights) });
      day = leave;
    }
    if (!placed.length) return null;
    const chain: ItinPlace[] = [home, ...placed, home];
    const legs: ItinLeg[] = chain.slice(1).map((to, i) => {
      const from = chain[i];
      const km = haversineKm(from.lat, from.lon, to.lat, to.lon);
      return { kind: km > 600 ? "fly" : "train", from, to, date: i === 0 ? placed[0].arrive : placed[Math.min(i, placed.length) - 1].leave, price: null, note: "not priced yet" };
    });
    const nights = placed.reduce((t, x) => t + x.nights, 0);
    return { title: placed.map((x) => x.name).join(", "), subtitle: `${nights} nights from ${home.name}`, origin: home, start: placed[0].arrive, end: placed[placed.length - 1].leave, nights, stops: placed, legs, source: "custom" };
  }
  // Anyone may open the itinerary view: window.dispatchEvent(new CustomEvent("atlas:itinerary", { detail: { skeleton } })).
  useEffect(() => {
    const onItin = (e: Event) => {
      const d = (e as CustomEvent<Omit<ItinOpen, "n">>).detail;
      if (d && (d.skeleton || d.itinerary)) openItineraryRef.current(d);
    };
    const onPlaceEv = (e: Event) => {
      const d = (e as CustomEvent<{ name?: string; code?: string }>).detail;
      if (d && (d.name || d.code)) openPlaceRef.current(d);
    };
    window.addEventListener("atlas:itinerary", onItin);
    window.addEventListener("atlas:place", onPlaceEv);
    return () => {
      window.removeEventListener("atlas:itinerary", onItin);
      window.removeEventListener("atlas:place", onPlaceEv);
    };
  }, []);

  // ---- The command line: every command lands here, from the top bar or an atlas:command event.
  const countryIdx = useMemo(() => countryIndexOf(countries), [countries]);
  /** Country words or codes to ISO2, through the same index the Trips forms use. */
  const countryCodes = (words: string[]): string[] => resolveCountries(words.join(","), countryIdx.index, countryIdx.known).codes;
  /** Close what sits in front of the tabs, so a command that runs in a tab shows its result. */
  function clearFront() {
    if (itin) closeItinerary();
    setPlacePage(null);
  }
  function runCommand(c: Command) {
    // The brain's 'walk' kind (lib/command.ts, another stream): matched by its name so this
    // builds before and after it lands; its fields are read loosely by walkFromCommand.
    if ((c.kind as string) === "walk") {
      walkFromCommand(c as unknown as Record<string, unknown>);
      return;
    }
    switch (c.kind) {
      case "route": {
        const base = emptyRouteForm();
        const o = originRef.current;
        const form: RouteForm = { ...base, from: c.from?.trim() || fromPlace || (o ? originAsPlace(o) : abFormRef.current.from), to: (c.to ?? "").trim(), depart: c.depart && /^\d{4}-\d{2}-\d{2}$/.test(c.depart) ? c.depart : base.depart, nights: c.nights && c.nights > 0 ? c.nights : base.nights, oneWay: !!c.oneWay, flex: c.flex != null && c.flex >= 0 && c.flex <= 3 ? c.flex : base.flex };
        // "/route" alone names no destination: open the card on its empty form (idle shows the
        // edit row) instead of sending a search the route API refuses.
        if (!form.to) {
          abCtrl.current?.abort();
          abCtrl.current = null;
          setAb({ status: "idle", lines: [], options: [] });
          setAbSelected(null);
          setAbForm(form);
          openRouteCard();
          return;
        }
        void searchRoute(form);
        return;
      }
      case "events": {
        const where = c.where?.trim();
        const country = where ? countryCodes([where])[0] : undefined;
        const words = [...(c.words ?? []), ...(where && !country ? [where] : [])];
        setEvLayer({ on: true, from: c.from ?? "", to: c.to ?? (c.from ? localIso(new Date(Date.parse(c.from) + 30 * 86_400_000)) : ""), words: words.length ? words : undefined, country, list: true });
        setEventSel(null);
        if (!isPhone()) cardOpenRef.current = true;
        spinRef.current = false;
        mapRef.current?.flyTo({ center: [origin?.lon ?? 20, Math.max(-20, Math.min(45, origin?.lat ?? 30))], zoom: isPhone() ? 1.1 : 1.5, duration: 1500, essential: true });
        return;
      }
      case "getaways": {
        clearFront();
        setView("deals");
        const from = c.from ?? localIso(new Date(Date.now() + 86_400_000));
        // The finder's window holds the whole trip (out and back inside it). A window of three
        // days or less is a weekend: it may come back on the Monday, one to three nights.
        // Any other window caps the nights at its length, so a trip never runs past it.
        const short = !!c.to && daysBetween(from, c.to) <= 2;
        const to = c.to ? (short ? addDays(c.to, 1) : c.to) : addDays(from, 21);
        const span = Math.max(1, daysBetween(from, to));
        const maxNights = Math.max(1, Math.min(span, c.maxNights ?? (short ? 3 : 5)));
        const minNights = Math.max(1, Math.min(maxNights, c.minNights ?? (short ? 1 : 2)));
        void runFinder({ origins: boardGateways.map((g) => g.iata), from, to, minNights, maxNights, direct: false, maxHours: c.maxHours, where: c.where?.trim() || "anywhere", returnTo: [], tricks: false });
        return;
      }
      case "wild": {
        clearFront();
        setView("trips");
        setTripMode("wild");
        const rk = regionKey(c.region);
        const codes = c.countries?.length ? countryCodes(c.countries) : c.region && !rk ? countryCodes([c.region]) : [];
        const nights = c.nights ? Math.max(5, Math.min(90, c.nights)) : undefined;
        if (rk) setWildRegion(rk);
        if (nights) setWildNights(nights);
        setTripsExtra((x) => ({ ...x, wild: { ...x.wild, countries: codes } }));
        if (rk || codes.length) void buildWildTrip({ region: rk ?? undefined, countries: codes, nights, nightsPerStop: c.nightsPerStop, unique: c.style === "unique", ground: c.ground });
        else setNotice("Pick a region on the globe, or name the countries, then build the loop.");
        return;
      }
      case "longstay": {
        clearFront();
        setView("trips");
        setTripMode("longstay");
        const rk = regionKey(c.region);
        const codes = c.countries?.length ? countryCodes(c.countries) : c.region && !rk ? countryCodes([c.region]) : [];
        const months = c.months ? Math.max(1, Math.min(6, Math.round(c.months))) : longStayForm.months;
        if (rk) setWildRegion(rk);
        setLongStayForm((f) => ({ ...f, months, countries: codes.join(", ") }));
        if (rk || codes.length) void findLongStay({ months, budget: longStayForm.budget, countries: codes, startMonth: (longStayForm.start ?? month) || undefined }, rk ?? undefined);
        else setNotice("Pick a region on the globe, or name the countries, then find the base.");
        return;
      }
      case "place":
        if (itin) closeItinerary();
        openPlace({ name: c.name });
        return;
      case "itinerary": {
        const sk = c.stops?.length ? customSkeleton(c.stops, c.start, c.from) : shownSkeleton();
        if (sk) openItinerary({ skeleton: sk });
        else setNotice(c.stops?.length ? "None of those places is on the map; try the city names." : "Nothing on show to plan yet: open a deal, a route, a loop or an event first, or type the stops (itinerary Lisbon 3 nights).");
        return;
      }
      case "ask":
        clearFront();
        setView("chat");
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
  }
  const runCommandRef = useRef(runCommand);
  runCommandRef.current = runCommand;
  // Anyone may run a command line: window.dispatchEvent(new CustomEvent("atlas:command", { detail: { text } })).
  useEffect(() => {
    const onCommand = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text?.trim();
      if (!text) return;
      const best = parseCommand(text, todayIso())[0];
      if (best) runCommandRef.current(best);
    };
    window.addEventListener("atlas:command", onCommand);
    return () => window.removeEventListener("atlas:command", onCommand);
  }, []);

  // The capabilities the panel places on its pages (Get there, events, Make an itinerary).
  const caps: Capabilities = {
    fromPlace,
    excludeQ,
    originPlace,
    onOpenRoute: (q, r) => {
      if (r && r.options.length) showRouteResult(r, undefined, q);
      else {
        const base = emptyRouteForm();
        void searchRoute({ ...base, from: q.from, to: q.to, depart: q.depart ?? base.depart, nights: q.nights ?? base.nights, oneWay: !!q.oneWay }, ROUTE_BUDGET_FREE);
      }
    },
    onEvent: (e) => {
      setEvLayer((l) => ({ ...l, on: true }));
      selectEvent(e);
    },
    onItinerary: (sk) => openItinerary({ skeleton: sk }),
    placeSkeleton: (pl) => placeSkeleton(pl),
    eventOf,
    eventsAtPlace,
  };

  const homeHolidays = useMemo(() => {
    const home = gateways[0]?.airport.country;
    if (!home) return [];
    const today = todayIso();
    const horizon = localIso(new Date(Date.now() + 120 * 86_400_000));
    return (holidays[home] ?? []).filter((h) => h.national && h.date >= today && h.date <= horizon).slice(0, 4);
  }, [gateways, holidays]);
  const anyFares = Object.values(faresByGateway).some((f) => f.status === "ok" && f.fares.length > 0);
  const fareSource = Object.values(faresByGateway).some((f) => f.note?.includes("Kiwi")) ? "one-way fares found on Kiwi.com (weekly search)" : "cached one-way fares from Aviasales searches";

  useEffect(() => {
    if (!shortOpen || !gateways.length) return;
    const ctrl = new AbortController();
    setTrips(null);
    const g = gateways.map((x) => `${x.airport.iata}:${x.airport.lat}:${x.airport.lon}:${x.driveMin}`).join(",");
    const sf = tripsExtra.short;
    // The trip style's avoid list (groups expanded to countries) joins the Been list: neither is ever a night.
    const skip = [...new Set([...exclude, ...avoidCodes(prefs)])];
    // ground= is the engine's own (minutes); cities, mustInclude and countries are the free-form asks.
    const extra = `${around ? `&around=${around}` : ""}${skip.length ? `&exclude=${skip.join(",")}` : ""}&ground=${sf.maxGroundHours * 60}&cities=${sf.cities}${sf.mustInclude.length ? `&mustInclude=${sf.mustInclude[0]}` : ""}${sf.countries.length ? `&countries=${sf.countries.join(",")}` : ""}`;
    fetch(`/api/trips?g=${g}&home=${gateways[0].airport.country}&days=${days}${extra}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((j: TripsResult) => {
        setTrips(j);
        setSelectedTrip((cur) => (cur && j.trips?.some((t) => t.id === cur) ? cur : (j.trips?.[0]?.id ?? null)));
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [shortOpen, gateways, days, around, exclude, tripsExtra.short, prefs]);

  // /api/trips already skips excluded countries; this client-side pass is belt and braces for a
  // cached answer from before the list changed, so nothing with such a night draws or lists.
  const tripsShown = useMemo<TripsResult | null>(() => {
    if (!trips || !exclude.length) return trips;
    return { ...trips, trips: trips.trips.filter((t) => t.cities.every((c) => countryAllowed(c.country, exclude))) };
  }, [trips, exclude]);
  // When the selected loop was dropped by the filter, the first loop left takes its place.
  useEffect(() => {
    if (!tripsShown) return;
    setSelectedTrip((cur) => (cur && tripsShown.trips.some((t) => t.id === cur) ? cur : (tripsShown.trips[0]?.id ?? null)));
  }, [tripsShown]);

  const trip: Trip | null = shortOpen && tripsShown ? (tripsShown.trips.find((t) => t.id === selectedTrip) ?? null) : null;
  const homeLabel = boardGateways[0]?.label ?? origin?.label ?? "Home";

  // The trip the globe draws and plays: the wild loop, the chat's loop or the short loop, as
  // stops and legs in one shape, plus the home point its route leaves from and returns to.
  const route = useMemo<{ stops: WildStop[]; legs: WildLeg[]; home: [number, number] | null } | null>(() => {
    // The itinerary on show is the route (its legs are drawn from coordinates, routeLegs below);
    // the open route card hides the trips underneath until it is folded or closed.
    if (itinRoute) return { stops: itinRoute.stops, legs: [], home: itinRoute.home };
    if (walkRoute) return { stops: walkRoute.stops, legs: [], home: walkRoute.home };
    if (covered) return null;
    const wt = wildOpen ? wild.trip : view === "chat" && chatTrip && !chatDeals.length ? chatTrip : null;
    if (wt) return { stops: wt.stops, legs: wt.legs, home: wildCoord(wt.home) };
    if (trip) {
      const r = shortLoopRoute(trip, homeLabel);
      const first = trip.legs[0];
      return { ...r, home: first?.kind === "fly" ? wildCoord(first.from) : origin ? [origin.lon, origin.lat] : null };
    }
    return null;
  }, [itinRoute, walkRoute, covered, wildOpen, wild.trip, view, chatTrip, chatDeals.length, trip, wildCoord, homeLabel, origin]);
  // Legs on the globe, coordinates resolved: a leg to the front door ends at the visitor.
  const routeLegs = useMemo<RouteLeg[]>(() => {
    if (itinRoute) return itinRoute.legs;
    if (walkRoute) return walkRoute.legs;
    if (!route) return [];
    const at = (code: string): [number, number] | null => wildCoord(code) ?? (origin && code === origin.label ? [origin.lon, origin.lat] : null);
    return route.legs.map((l) => ({ from: at(l.from), to: at(l.to), kind: l.kind })).filter((x): x is RouteLeg => !!x.from && !!x.to);
  }, [itinRoute, walkRoute, route, wildCoord, origin]);

  // Play the route: the camera flies home, then to each stop in turn, then home, 2.5 s a hop;
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
    // On a phone the flight is the point, so the sheet drops to a peek for the duration and
    // comes back to half once the camera is home again (a touch that cancels it leaves it).
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

  // Picking a region: the chips, the tags on the globe and the chat all land here.
  function selectRegion(key: string) {
    setWildRegion(key);
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
    // The pick dropped the phone sheet to show the globe; the reply streams into the chat,
    // so the sheet comes back up for it.
    if (isPhone() && viewRef.current === "chat") setSheet("full");
  }
  pickedRef.current = picked;
  function cancelPick() {
    pickRef.current = null;
    setPick(null);
    if (isPhone() && viewRef.current === "chat") setSheet("full");
  }
  // The chat asks for a pick; the globe shows the region tags, the period picker or waits for a tap.
  useEffect(() => {
    const onPick = (e: Event) => {
      const d = (e as CustomEvent<{ mode?: PickMode }>).detail;
      if (d?.mode !== "region" && d?.mode !== "dates" && d?.mode !== "place") return;
      setPick(d.mode);
      if (isPhone()) setSheet(d.mode === "dates" ? "full" : "peek");
      if (d.mode === "region") {
        const map = mapRef.current;
        spinRef.current = false;
        map?.flyTo({ center: [50, 15], zoom: 1.5, duration: 1600, essential: true });
      }
    };
    window.addEventListener("atlas:pick", onPick);
    return () => window.removeEventListener("atlas:pick", onPick);
  }, []);
  /** A tap on a place while the chat waits for one: answer it, and still open the place. */
  const placePicked = (name: string) => {
    if (pickRef.current === "place") picked({ mode: "place", place: name });
  };

  // On a phone the sheet opens fully for a conversation, and to half for a trip: the route,
  // the numbered stops and the camera playing through them need the globe in view.
  useEffect(() => {
    if (!isPhone()) return;
    if (view === "chat") setSheet("full");
    else if ((wildOpen && wild.status === "ok") || (shortOpen && selectedTrip)) setSheet("half");
  }, [view, wildOpen, wild.status, shortOpen, selectedTrip]);
  // The cards on the map cover its right edge on desktop: framing keeps clear of them.
  cardOpenRef.current = !isPhone() && (cardShown || (walk.open && walk.status !== "idle") || !!eventSel || (evLayer.on && evLayer.list));
  useEffect(() => stopPlay, [view, tripMode, selectedTrip, wild.trip, itin?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = searching || asking || walk.status === "loading" || wild.status === "loading" || ab.status === "loading" || finder.status === "loading" || longStay.status === "loading" || group.status === "loading" || plan.status === "loading" || liveSearch?.status === "loading" || combos.status === "loading" || (shortOpen && !trips);

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
    const out: LabelItem[] = [];
    // Region tags: while choosing where a loop or a long stay goes, or when the chat asks.
    // They come after the stops and bases so a result always wins the space.
    const regions: LabelItem[] = [];
    const picking = (!covered && view === "trips" && (tripMode === "wild" || tripMode === "longstay")) || pick === "region";
    const showingResult = !!route || (view === "trips" && tripMode === "longstay" && longStay.status === "ok");
    if (picking) {
      for (const r of WILD_REGIONS) {
        const c = REGION_CENTROIDS[r.key];
        regions.push({ key: `region:${r.key}`, lon: c[1], lat: c[0], text: r.label, kind: "region", hot: r.key === wildRegion && !showingResult });
      }
    }
    // The events layer's tags come right after a route's own tags, before everything else.
    const evs: LabelItem[] = eventSpots.map((e) => ({ key: `event:${e.key}`, lon: e.lon, lat: e.lat, text: e.name, sub: dateRange(e.start, e.end), kind: "event" as const, hot: eventSel?.key === e.key }));
    // The place page's city gets its own tag, so the page and the globe point at the same spot.
    if (placePage && !itinShowing) evs.unshift({ key: "place:open", lon: placePage.lon, lat: placePage.lat, text: placePage.name, kind: "base", hot: true });
    if (eventSel && !eventSpots.some((e) => e.key === eventSel.key)) evs.unshift({ key: `event:${eventSel.key}`, lon: eventSel.lon, lat: eventSel.lat, text: eventSel.name, sub: dateRange(eventSel.start, eventSel.end), kind: "event", hot: true });
    if (walkShowing) {
      // The walk thinking: the cities it expanded with the money so far, the price of every edge
      // it just looked at for a few seconds; then the loop it chose, numbered.
      if (route) out.push(...route.stops.map((st, i) => ({ key: `stop:${i}`, lon: st.lon, lat: st.lat, text: `${i + 1} · ${st.name} · ${st.nights}n`, kind: "stop" as const, hot: playing === i })));
      if (walk.status === "loading") {
        const onLoop = new Set(route?.stops.map((st) => st.code) ?? []);
        for (const n of [...walk.nodes].reverse()) if (n.code !== "HOME" && !onLoop.has(n.code)) out.push({ key: `walk:node:${n.code}`, lon: n.lon, lat: n.lat, text: n.name, sub: n.money != null ? `€${n.money} so far` : shortDate(n.date), kind: "walk" });
        for (const e of walk.edges.slice(-60).reverse()) if (walkClock - e.at < EDGE_TAG_MS) out.push({ key: `walk:edge:${e.from}>${e.to}>${e.kind}>${Math.round(e.at)}`, lon: e.lon, lat: e.lat, text: `€${Math.round(e.price)}`, kind: "walkedge", cheap: e.price < 40 });
      }
      return [...out, ...evs];
    }
    if (abShowing && ab.result) {
      // A side the engine could not place (placed: false, borrowed or null coordinates) gets no tag: it would sit on the other city or on null island.
      const { from, to } = ab.result;
      if (routeEndKnown(from)) out.push({ key: "ab:from", lon: from.lon, lat: from.lat, text: from.label, kind: "stop", hot: true });
      if (routeEndKnown(to)) out.push({ key: "ab:to", lon: to.lon, lat: to.lat, text: `${to.label}${abOption ? ` · ${abOption.total ? `€${Math.round(abOption.total)}` : ""}` : ""}`, kind: "stop", hot: true });
      return [...out, ...evs];
    }
    if (route) {
      // Numbered stops of the trip on the globe; the one the camera is on is lit.
      out.push(...route.stops.map((st, i) => ({ key: `stop:${i}`, lon: st.lon, lat: st.lat, text: `${i + 1} · ${st.name} · ${st.nights}n`, kind: "stop" as const, hot: playing === i })));
      return [...out, ...evs, ...regions];
    }
    out.push(...evs);
    if (covered) return out;
    if (view === "trips" && tripMode === "longstay" && longStay.status === "ok" && longStay.result) {
      for (const b of longStay.result.bases) out.push({ key: `base:${b.code}`, lon: b.lon, lat: b.lat, text: b.name, sub: `€${b.perDay} a day`, kind: "base", hot: b.code === selectedBase });
      return [...out, ...regions];
    }
    out.push(...regions);
    if (view === "trips" && tripMode === "group" && group.status === "ok" && group.result) {
      group.result.options.forEach((o, i) => {
        const c = wildCoord(o.dstCity);
        if (c) out.push({ key: `option:${i}`, lon: c[0], lat: c[1], text: `€${o.total}`, sub: o.city, kind: "base", hot: i === selectedOption, cheap: i === 0 });
      });
      return out;
    }
    if (view !== "deals" && view !== "chat") return out;
    for (const d of dealsList.slice(0, 80)) {
      const c = dealCoord(d);
      if (!c) continue;
      const key = dealKey(d);
      out.push({ key, lon: c[0], lat: c[1], text: `€${d.price}`, hot: key === selectedDeal || key === hoveredDeal, cheap: d.price < 60 });
    }
    if (deal && !out.some((x) => x.key === selectedDeal)) {
      const c = dealCoord(deal);
      // Pushed, not unshifted: a tag added at the front moves every DOM node after it, which replays their pop-in.
      if (c) out.push({ key: dealKey(deal), lon: c[0], lat: c[1], text: `€${deal.price}`, hot: true, cheap: deal.price < 60 });
    }
    // No sorting here: a hovered or selected tag moving to the front of the list made React move
    // every DOM node before it, and a moved node replays its pop-in animation, so hovering one
    // price re-animated them all. PriceLabels places hot tags first on its own, in a stable DOM.
    return out;
  }, [view, tripMode, pick, wildRegion, route, playing, longStay, selectedBase, group, selectedOption, wildCoord, dealsList, deal, selectedDeal, hoveredDeal, dealCoord, abShowing, ab.result, abOption, covered, eventSpots, eventSel, placePage, itinShowing, walkShowing, walk.status, walk.nodes, walk.edges, walkClock]);
  function pickLabel(key: string) {
    if (key.startsWith("ab:") || key.startsWith("place:") || key.startsWith("walk:")) return;
    if (key.startsWith("event:")) {
      const e = eventSpots.find((x) => `event:${x.key}` === key) ?? (eventSel && `event:${eventSel.key}` === key ? eventSel : null);
      if (e) selectEvent(e);
      return;
    }
    if (key.startsWith("region:")) return selectRegion(key.slice(7));
    if (key.startsWith("stop:")) return focusStop(Number(key.slice(5)));
    if (key.startsWith("base:")) {
      const code = key.slice(5);
      setSelectedBase((cur) => (cur === code ? null : code));
      const c = wildCoord(code);
      if (c) mapRef.current?.flyTo({ center: c, zoom: 6, duration: 1300, padding: panelPadding() });
      return;
    }
    if (key.startsWith("option:")) {
      const i = Number(key.slice(7));
      setSelectedOption((cur) => (cur === i ? null : i));
      return;
    }
    focusDeal(key);
  }

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
    // The stop the camera is on while the route plays pulses in mint.
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
      // While nothing moves the triggers hold still, so deck.gl does not rebuild 200 paths a frame for nothing.
      const tick = moving ? Math.floor(now / 33) : -wd.v;
      const alpha = (e: WalkEdgeView): number => {
        if (wd.done && wd.best.has(`${e.from}>${e.to}`)) return 235;
        if (e.chosen) return wd.done ? 90 : 235;
        const floor = wd.done ? 16 : 44;
        if (reduced) return wd.done ? floor : 110;
        const t = Math.max(0, (now - e.at - EDGE_GROW_MS) / EDGE_FADE_MS);
        return Math.round(Math.max(floor, 210 - (210 - floor) * t));
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
        // A node pulses when it arrives; the latest keeps pulsing while the walk works from it.
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
    // Deals and route options a live search just found: an arc grows from where they leave and fades.
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

    // A touch of the globe stops the slow spin and any route being played.
    const stop = () => {
      spinRef.current = false;
      stopPlayRef.current();
    };
    map.on("mousedown", stop);
    map.on("touchstart", stop);
    map.on("wheel", stop);
    // While the chat waits for a place, a tap anywhere on the globe answers with the nearest
    // city; a tap on a pin or a dot answers through its own handler first and clears the pick.
    map.on("click", (e) => {
      if (pickRef.current !== "place") return;
      const name = cityNearTap(citiesRef.current, e.lngLat.lat, e.lngLat.lng, map.getZoom());
      if (name) pickedRef.current({ mode: "place", place: name });
    });
    // The latitude grid shows only when the whole globe is in view.
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

  function fitTo(lat: number, lon: number, maxZoom: number) {
    const map = mapRef.current;
    if (!map || !origin) return;
    const bounds = new maplibregl.LngLatBounds([origin.lon, origin.lat], [origin.lon, origin.lat]).extend([lon, lat]);
    map.fitBounds(bounds, { padding: panelPadding(), maxZoom, duration: 1300 });
  }

  function focusDestination(iata: string | null) {
    setSelectedDest(iata);
    const dest = iata ? byIata.get(iata) : null;
    if (dest) placePicked(dest.city ?? dest.name);
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
    if (s) {
      placePicked(s.town || s.name);
      fitTo(s.lat, s.lon, 7);
    }
  }

  function focusPlace(key: string | null) {
    setSelectedPlace(key);
    if (key === "here" && origin) {
      fitTo(origin.lat, origin.lon, 10);
      return;
    }
    const p = key ? places.find((x) => x.key === key) : null;
    setSelectedStation(p?.ground && p.mode !== "plane" ? p.ground.id : null);
    if (p) {
      placePicked(p.name);
      fitTo(p.lat, p.lon, p.mode === "plane" ? 5 : 7);
    }
  }

  function focusTrip(id: string | null) {
    setSelectedTrip(id);
    const t = id ? tripsShown?.trips.find((x) => x.id === id) : null;
    const map = mapRef.current;
    if (!map || !t || !origin) return;
    const bounds = new maplibregl.LngLatBounds([origin.lon, origin.lat], [origin.lon, origin.lat]);
    for (const c of t.cities) bounds.extend([c.lon, c.lat]);
    map.fitBounds(bounds, { padding: panelPadding(), maxZoom: 6, duration: 1400 });
  }

  function focusDeal(key: string | null) {
    const d = key ? (dealsAll.find((x) => matchDealKey(x, key)) ?? chatDeals.find((x) => matchDealKey(x, key))) : null;
    // A pin tapped while the chat waits for a place answers the chat and stays on the Ask tab:
    // switching to Deals would unmount the chat and lose the reply it is about to stream.
    const answering = !!d && pickRef.current === "place";
    if (d) placePicked(d.city);
    if (key && !answering && (view === "chat" || view === "trips")) setView("deals");
    setSelectedDeal(key);
    setLiveSearch(null);
    if (key && !answering && sheetRef.current === "peek") setSheet("half");
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

  // The trail: the great circle of the open deal, or the whole route of the trip on show
  // (great circles for flights, straight lines for ground hops), run end to end.
  useEffect(() => {
    if (deal && !covered && (view === "deals" || view === "chat")) {
      const g = gwCoord(deal.gw);
      const c = dealCoord(deal);
      if (!g || !c) {
        trailRef.current = null;
        return;
      }
      const path = greatCircle(g, c, 72);
      trailRef.current = { path, timestamps: path.map((_, i) => i) };
      return;
    }
    trailRef.current = routeLegs.length ? routePath(routeLegs) : abLegs.length ? routePath(abLegs) : null;
  }, [deal, view, gwCoord, dealCoord, routeLegs, abLegs, covered]);

  // deck.gl layers follow the state. Globe needs back-face culling off or arcs disappear.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const colorOf = (d: Destination): RGBA => (live ? (d.fare ? priceColor(d.fare.price) : DIM) : arcColor(flightMinutes(d.km)));
    const ground = view === "ground";
    const all = view === "all";
    const fly = view === "fly";
    // The itinerary and the open route card hold the globe: the layers of the tab underneath wait.
    const tripView = shortOpen && !covered;
    const dealView = !covered && (view === "deals" || (view === "chat" && chatDeals.length > 0));
    const wildView = !covered && (wildOpen || (view === "chat" && !!chatTrip && chatDeals.length === 0));
    const wildTrip = wildOpen ? wild.trip : view === "chat" ? (chatTrip ?? undefined) : undefined;
    const bases = !covered && view === "trips" && tripMode === "longstay" && longStay.status === "ok" ? (longStay.result?.bases ?? []) : [];
    const groupOptions = !covered && view === "trips" && tripMode === "group" && group.status === "ok" ? (group.result?.options ?? []) : [];
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
    for (const t of tripsShown?.trips ?? []) for (const c of t.cities) tripCities.set(c.code, c);
    const isHot = (x: DealDot) => dealKey(x.d) === selectedDeal || dealKey(x.d) === hoveredDeal;

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
      bases.length
        ? new ScatterplotLayer<(typeof bases)[number]>({
            id: "bases",
            data: bases,
            getPosition: (b) => [b.lon, b.lat],
            radiusUnits: "pixels",
            getRadius: (b) => (b.code === selectedBase ? 9 : 6),
            getFillColor: (b) => (b.code === selectedBase ? MINT : [255, 180, 84, 240]),
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: 2,
            getLineColor: [5, 7, 14, 230],
            pickable: true,
            updateTriggers: { getRadius: [selectedBase], getFillColor: [selectedBase] },
            onClick: (info) => {
              const b = info.object as (typeof bases)[number] | undefined;
              if (b) pickLabel(`base:${b.code}`);
            },
          })
        : null,
      groupOptions.length
        ? new ArcLayer<{ s: [number, number]; t: [number, number] }>({
            id: "group-arcs",
            data: (selectedOption != null ? [groupOptions[selectedOption]] : groupOptions.slice(0, 1))
              .filter(Boolean)
              .flatMap((o) => o.perMember.map((m) => ({ s: wildCoord(m.from), t: wildCoord(o.dstCity) })))
              .filter((x): x is { s: [number, number]; t: [number, number] } => !!x.s && !!x.t),
            getSourcePosition: (x) => x.s,
            getTargetPosition: (x) => x.t,
            getSourceColor: [124, 196, 255, 220],
            getTargetColor: [111, 240, 196, 230],
            getWidth: 2.5,
            greatCircle: true,
            parameters: { cullMode: "none" },
          })
        : null,
      groupOptions.length
        ? new ScatterplotLayer<(typeof groupOptions)[number] & { c: [number, number] }>({
            id: "group-cities",
            data: groupOptions.map((o) => ({ ...o, c: wildCoord(o.dstCity) })).filter((o): o is (typeof groupOptions)[number] & { c: [number, number] } => !!o.c),
            getPosition: (o) => o.c,
            radiusUnits: "pixels",
            getRadius: 6,
            getFillColor: [111, 240, 196, 240],
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: 2,
            getLineColor: [5, 7, 14, 230],
          })
        : null,
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
      abStreamLegs.length
        ? new PathLayer<RouteLeg>({
            id: "ab-stream",
            data: abStreamLegs,
            getPath: (l) => (l.kind === "fly" ? greatCircle(l.from, l.to, 40) : [l.from, l.to]),
            getColor: (l) => (l.kind === "fly" ? [124, 196, 255, 110] : [255, 180, 84, 130]),
            getWidth: 1.5,
            widthUnits: "pixels",
            parameters: { cullMode: "none" },
          })
        : null,
      overlayLegs.length
        ? new ArcLayer<RouteLeg>({
            id: "ab-arcs",
            data: overlayLegs.filter((l) => l.kind === "fly"),
            getSourcePosition: (x) => x.from,
            getTargetPosition: (x) => x.to,
            getSourceColor: [111, 240, 196, 230],
            getTargetColor: [124, 196, 255, 230],
            getWidth: 3,
            greatCircle: true,
            parameters: { cullMode: "none" },
          })
        : null,
      overlayLegs.length
        ? new PathLayer<RouteLeg>({
            id: "ab-ground",
            data: overlayLegs.filter((l) => l.kind === "ground"),
            getPath: (l) => [l.from, l.to],
            getColor: [255, 180, 84, 240],
            getWidth: 3.5,
            widthUnits: "pixels",
            parameters: { cullMode: "none" },
          })
        : null,
      overlayPoints.length
        ? new ScatterplotLayer<{ p: [number, number] }>({
            id: "ab-points",
            data: overlayPoints.map((p) => ({ p })),
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
      eventSpots.length
        ? new ScatterplotLayer<EventSpot>({
            id: "event-dots",
            data: eventSpots,
            getPosition: (e) => [e.lon, e.lat],
            radiusUnits: "pixels",
            getRadius: (e) => (e.key === eventSel?.key ? 9 : 6),
            getFillColor: (e) => (e.key === eventSel?.key ? [255, 107, 138, 255] : [255, 107, 138, 210]),
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: 2,
            getLineColor: [255, 255, 255, 230],
            pickable: true,
            updateTriggers: { getRadius: [eventSel?.key], getFillColor: [eventSel?.key] },
            onClick: (info) => {
              const e = info.object as EventSpot | undefined;
              if (e) selectEvent(e);
            },
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
      ground || tripView || dealView || wildView || covered
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
  }, [airports, shown, gateways, gatewayIata, origin, selectedDest, live, view, reachBand, selectedStation, pathForSelected, placesShown, selectedPlace, tripsShown, trip, warmOnly, weather, dealsList, selectedDeal, hoveredDeal, deal, render, selectedCombo, combos, sightsOnMap, sights, wild.trip, wildCoord, chatTrip, chatDeals, shortOpen, wildOpen, tripMode, longStay, selectedBase, group, selectedOption, lowZoom, overlayLegs, overlayPoints, abStreamLegs, covered, itinShowing, eventSpots, eventSel]);

  const groundFeeds = reach ? reach.feeds.map((f) => f.attribution.split(" via ")[0].split(" (")[0]).join(", ") : "";

  // Where "Back" returns to from the itinerary: the tab (or page) that was in front.
  const backTo = placePage ? placePage.name : view === "chat" ? "the chat" : view === "deals" ? (deal ? deal.city : "Deals") : view === "trips" ? "Trips" : "Explore";
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
            if (!map || !Number.isFinite(f.lat) || !Number.isFinite(f.lon) || (f.lat === 0 && f.lon === 0)) return;
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
  const eventsCardOpen = !!eventSel || (evLayer.on && evLayer.list);

  // The chat's context: where the traveller is, their airports, month and Been list, and the
  // trip style, which the server turns into one line of the agent's prompt (lib/prefs.ts
  // prefsLine), so "a loop in the Balkans" in the chat stays 2 to 3 nights a place too.
  const chatContext: ChatContext & { prefs: Prefs } = { origin: origin ? { lat: origin.lat, lon: origin.lon, label: origin.label } : undefined, gateways: boardGateways.map((g) => g.iata), home: gateways[0]?.airport.country ?? "RO", month: month ?? undefined, been: been.countries.length ? { countries: been.countries, newOnly: been.newOnly } : undefined, prefs };

  return (
    <div className={`app sheet-${sheet}`}>
      <div className="space" />
      <div ref={mapEl} className="map" />
      <div className="vignette" aria-hidden="true" />
      <PriceLabels map={mapObj} items={labelItems} onPick={pickLabel} onHover={(k) => setHoveredDeal(k && !k.includes(":") ? k : null)} />
      <div className={`progressline${busy ? " on" : ""}`} aria-hidden="true" />
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
        busy={busy}
        onCommand={runCommand}
        onShare={share}
        copied={copied}
        been={been}
        onBeen={setBeen}
        countries={countries}
        prefs={prefs}
      />
      {/* The layers and cards that belong to the map, not to a tab: they stay while the tabs change. */}
      <div className="mapchips">
        <button className={`mapchip${evLayer.on ? " on" : ""}`} onClick={toggleEvents} title="Events worth flying for, on the globe, for the When window or the next four months">
          <span aria-hidden="true">✺</span> Events
          {evLayer.on && eventSpots.length > 0 ? <small>{eventSpots.length}</small> : null}
        </button>
        <button
          className={`mapchip${routeCard.open ? " on" : ""}`}
          onClick={() => (routeCard.open ? setRouteCard({ open: false, collapsed: false }) : openRouteCard())}
          title="The cheapest way from one place to another, by air, rail, coach and ferry"
        >
          <span aria-hidden="true">⇄</span> A to B
        </button>
      </div>
      <div className="mapcards">
        {notice && (
          <div className="mapnotice" role="status">
            {notice}
            <button className="iconbtn" onClick={() => setNotice(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {eventsCardOpen && (
          <EventsCard
            events={eventSpots}
            from={evWindow.from}
            to={evWindow.to}
            selected={eventSel}
            onSelect={(e) => (e ? selectEvent(e) : setEventSel(null))}
            onClose={() => {
              if (eventSel && evLayer.list) setEventSel(null);
              else {
                setEventSel(null);
                setEvLayer((l) => ({ ...l, list: false }));
              }
            }}
            fromPlace={fromPlace}
            exclude={excludeQ}
            onOpenRoute={caps.onOpenRoute}
            onItinerary={(e) => openItinerary({ skeleton: eventSkeleton(e) })}
            pricing={faresLive}
            onPriceLive={() => void priceEventsLive()}
            onPlace={(e) => openPlace({ code: e.city, name: e.cityName })}
            startCollapsed={isPhone()}
          />
        )}
        {walk.open && walk.status !== "idle" && (
          <WalkCard
            walk={walk}
            homeLabel={homeLabel}
            onSelect={selectWalkLoop}
            onItinerary={(i) => {
              const loop = walk.loops[i];
              const o = walkOriginPlace(walk.params);
              if (loop && o) openItinerary({ skeleton: skeletonFromWalk(loop, o) });
            }}
            onMoreBudget={() => void runWalk({ ...(walk.params ?? {}), budget: WALK_MORE_BUDGET }, walk.source ?? "event")}
            onCancel={cancelWalk}
            onClose={closeWalk}
            onCollapse={(c) => {
              setWalk((w) => ({ ...w, collapsed: c }));
              // Unfolded, the walk takes the globe back from the route card.
              if (!c) setRouteCard((r) => (r.open && !r.collapsed ? { ...r, collapsed: true } : r));
            }}
          />
        )}
        {routeCard.open && (
          <RouteCard
            form={abForm}
            onForm={setAbForm}
            state={ab}
            onSearch={(f, b) => void searchRoute(f, b)}
            onCancel={cancelRoute}
            selected={abSelected}
            onSelect={(i) => {
              setAbSelected(i);
              if (i != null && ab.result) framePoints(routeEnds(ab.result), 6);
            }}
            onItinerary={(i) => {
              const o = ab.options[i];
              const k = o && ab.result ? ab.result.options.findIndex((x) => optionKey(x) === optionKey(o)) : -1;
              if (ab.result && k >= 0) openItinerary({ skeleton: routeSkeleton(ab.result, k) });
              else setNotice("Wait for the search to finish, then make the itinerary.");
            }}
            collapsed={routeCard.collapsed}
            onCollapse={(c) => {
              setRouteCard({ open: true, collapsed: c });
              if (!c) setWalk((w) => (w.open && !w.collapsed ? { ...w, collapsed: true } : w));
            }}
            onClose={() => {
              cancelRoute();
              if (pick === "place") cancelPick();
              setRouteCard({ open: false, collapsed: false });
            }}
            // "Pick on the globe": the same place pick the chat uses; the tap answers through atlas:picked.
            onTapGlobe={() => {
              if (pick === "place") {
                cancelPick();
                return;
              }
              setPick("place");
              if (isPhone()) setSheet("peek");
            }}
            tapping={pick === "place" && routeCard.open}
            airports={airports}
            cities={cities}
            gateways={gateways}
            homeLabel={homeLabel}
            excludedCount={exclude.length}
            tradeoff={prefs.tradeoff}
          />
        )}
      </div>
      <Panel
        caps={caps}
        front={itineraryView}
        placePage={placePage}
        onClosePlace={() => setPlacePage(null)}
        view={view}
        onView={(v) => {
          // A tab chosen closes the place page and the itinerary in front of the tabs.
          setPlacePage(null);
          if (itin) closeItinerary();
          changeView(v);
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
        chatContext={chatContext}
        chatSeed={chatSeed}
        onChatSeedConsumed={() => setChatSeed(null)}
        onChatDeals={onChatDeals}
        onChatTrip={onChatTrip}
        been={been}
        finder={finder}
        onFinder={runFinder}
        onFinderClear={() => {
          finderCtrl.current?.abort();
          finderCtrl.current = null;
          setFinder({ status: "idle", deals: [], lines: [] });
          setSelectedDeal(null);
        }}
        tripsPanel={{
          mode: tripMode,
          onMode: (m) => {
            setTripMode(m);
            setSelectedTrip(null);
            setSelectedDeal(null);
            // Choosing a region wants the whole globe in view, centred on the current pick.
            if ((m === "wild" && wild.status !== "ok") || (m === "longstay" && longStay.status !== "ok")) {
              const c = REGION_CENTROIDS[wildRegion];
              spinRef.current = false;
              mapRef.current?.flyTo({ center: c ? [c[1], c[0]] : [50, 15], zoom: isPhone() ? 1.1 : 1.6, duration: 1600, essential: true });
            }
          },
          month,
          airports,
          gateways,
          countries,
          cities,
          extra: tripsExtra,
          onExtra: setTripsExtra,
          originPlace,
          onItinerary: (sk) => openItinerary({ skeleton: sk }),
          top: hasSaved ? <MyTrips onOpen={(it) => openItinerary({ itinerary: it })} /> : null,
          homeLabel,
          airlines,
          playing,
          onPlay: playRoute,
          onStopPlay: stopPlay,
          onFocusStop: focusStop,
          trips: tripsShown,
          selectedTrip,
          onTrip: focusTrip,
          days,
          onDays: setDays,
          homeHolidays,
          around,
          onAround: setAround,
          wild,
          wildRegion,
          onWildRegion: selectRegion,
          wildNights,
          onWildNights: setWildNights,
          wildStyle,
          onWildStyle: setWildStyle,
          wildBudget,
          onWildBudget: setWildBudget,
          wildTradeoff,
          onWildTradeoff: setWildTradeoff,
          wildVariants,
          onWildVariants: setWildVariants,
          wildPeriod,
          onWildPeriod: setWildPeriod,
          onWild: buildWildTrip,
          onWildAlternative: showAlternative,
          plan,
          onPlan: planWild,
          longStay,
          longStayForm,
          onLongStayForm: setLongStayForm,
          onLongStay: findLongStay,
          selectedBase,
          onBase: (code) => {
            setSelectedBase(code);
            const c = code ? wildCoord(code) : null;
            if (c) mapRef.current?.flyTo({ center: c, zoom: 6, duration: 1300, padding: panelPadding() });
          },
          group,
          groupForm,
          onGroupForm: setGroupForm,
          onGroup: findGroup,
          selectedOption,
          onOption: setSelectedOption,
          excludedCount: exclude.length,
          walk,
          onSmartLoop: runSmartLoop,
          prefs,
          onWalkSelect: selectWalkLoop,
        }}
        onHere={showHere}
        pick={pick}
        pickPeriod={pickPeriod}
        onPickPeriod={setPickPeriod}
        onPicked={picked}
        onPickCancel={cancelPick}
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

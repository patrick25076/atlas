"use client";

import { useMemo, useState } from "react";
import { flightMinutes, formatDuration } from "@/lib/geo";
import { sunTimes, tzOffsetMinutes } from "@/lib/sun";
import type { Place, PlaceMode } from "@/lib/places";
import type { TripsResult } from "@/lib/trips";
import type { PlaceSummary } from "@/app/api/place/route";
import type {
  Airport,
  CityPlaces,
  CountryInfo,
  Destination,
  FaresResponse,
  Gateway,
  Holiday,
  ReachResponse,
  ReachStation,
  WeatherDay,
} from "@/lib/types";
import { countryName, type Origin } from "./Globe";

/** Everything we know about the selected place's city and country. */
export type Intel = {
  code?: string;
  tz?: string;
  lat?: number;
  lon?: number;
  countryCode?: string;
  country?: CountryInfo;
  weather?: WeatherDay[];
  holidays?: Holiday[];
  places?: CityPlaces;
  pop?: number;
  heritage?: { name: string; km: number }[];
  visa?: { passport: string; text: string | null; updated: string };
};

function people(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

const PLACE_LABELS: [keyof CityPlaces, string][] = [
  ["food", "restaurants"],
  ["cafe", "cafés"],
  ["bar", "bars"],
  ["night", "nightlife"],
  ["culture", "culture"],
  ["nature", "parks & nature"],
  ["shop", "shopping"],
  ["stay", "places to stay"],
];

function count(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

export type View = "all" | "fly" | "ground" | "trips";
export type Band = "all" | "short" | "medium" | "long";
export const BANDS: { key: Band; label: string; test: (min: number) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "short", label: "Under 2h", test: (m) => m < 120 },
  { key: "medium", label: "2 to 5h", test: (m) => m >= 120 && m < 300 },
  { key: "long", label: "5h and more", test: (m) => m >= 300 },
];

export const MODE_LABEL: Record<PlaceMode, string> = { plane: "Fly", rail: "Train", coach: "Coach", ferry: "Ferry", other: "Ride" };
const MODE_TAG: Record<string, string> = { plane: "FLY", rail: "TRN", coach: "BUS", ferry: "FRY", walk: "WLK", other: "···" };

type Props = {
  origin: Origin | null;
  airports: Airport[];
  gateways: Gateway[];
  routeCounts: Record<string, number>;
  gatewayIata: string | null;
  onGateway: (iata: string) => void;
  band: Band;
  onBand: (b: Band) => void;
  destinations: Destination[];
  totalDestinations: number;
  selectedDest: string | null;
  onDest: (iata: string | null) => void;
  onOrigin: (a: Airport) => void;
  fares: FaresResponse | null;
  anyFares: boolean;
  airlines: Record<string, string>;
  pricedOnly: boolean;
  onPricedOnly: (v: boolean) => void;
  bigOnly: boolean;
  onBigOnly: (v: boolean) => void;
  view: View;
  onView: (v: View) => void;
  reach: ReachResponse | null;
  reachShown: ReachStation[];
  selectedStation: number | null;
  onStation: (id: number | null) => void;
  places: Place[];
  totalPlaces: number;
  selectedPlace: string | null;
  onPlace: (key: string | null) => void;
  trips: TripsResult | null;
  selectedTrip: string | null;
  onTrip: (id: string | null) => void;
  days: number;
  onDays: (d: number) => void;
  intel: Intel | null;
  summary: PlaceSummary | null;
  weatherReady: boolean;
  warmOnly: boolean;
  onWarmOnly: (v: boolean) => void;
  homeHolidays: Holiday[];
  around: string | null;
  onAround: (d: string | null) => void;
};

const GROUND_TAG: Record<string, string> = { rail: "TRN", coach: "BUS", ferry: "FRY", walk: "WLK" };

function glyph(sym: string): string {
  if (sym.includes("thunder")) return "⛈";
  if (sym.includes("snow") || sym.includes("sleet")) return "❄";
  if (sym.includes("rain")) return "🌧";
  if (sym.includes("fog")) return "🌫";
  if (sym === "clearsky") return "☀";
  if (sym === "fair") return "🌤";
  if (sym === "partlycloudy") return "⛅";
  if (sym === "cloudy") return "☁";
  return "·";
}

function weekday(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "short" });
}

function rate(r: number): string {
  return r >= 100 ? r.toFixed(0) : r >= 10 ? r.toFixed(1) : r.toFixed(2);
}

function PlaceIntel({ intel, summary }: { intel: Intel; summary: PlaceSummary | null }) {
  const c = intel.country;
  let time: string | null = null;
  let daylight: string | null = null;
  let shift: string | null = null;
  try {
    if (intel.tz) {
      const fmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: intel.tz });
      time = fmt.format(new Date());
      if (intel.lat != null && intel.lon != null) {
        const sun = sunTimes(intel.lat, intel.lon);
        if (sun) daylight = `${fmt.format(sun.sunrise)} to ${fmt.format(sun.sunset)}`;
      }
      const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const there = tzOffsetMinutes(intel.tz);
      const home = tzOffsetMinutes(here);
      if (there != null && home != null && there !== home) {
        const h = (there - home) / 60;
        shift = `${h > 0 ? "+" : ""}${Number.isInteger(h) ? h : h.toFixed(1)} h from you`;
      }
    }
  } catch {
    time = null;
  }
  const a = c?.advisory;
  return (
    <div className="intel">
      {intel.weather && intel.weather.length > 0 && (
        <div className="wx" title="MET Norway forecast, CC BY 4.0">
          {intel.weather.slice(0, 6).map((d) => (
            <div key={d.d} className="wxday">
              <span className="wxd">{weekday(d.d)}</span>
              <span className="wxg">{glyph(d.sym)}</span>
              <span className="wxt">{d.tmax}°</span>
            </div>
          ))}
        </div>
      )}
      <div className="facts">
        {intel.pop ? <span>{people(intel.pop)} people</span> : null}
        {time && (
          <span>
            Local time {time}
            {shift ? ` (${shift})` : ""}
          </span>
        )}
        {daylight && <span>Daylight {daylight}</span>}
        {c?.currency && (
          <span>
            {c.currency}
            {c.rate && c.currency !== "EUR" ? ` · 1 € = ${rate(c.rate)} ${c.currency}` : ""}
          </span>
        )}
        {c?.plugs && c.plugs.length > 0 && (
          <span>
            Plugs {c.plugs.slice(0, 3).join(", ")}
            {c.voltage ? ` · ${c.voltage} V` : ""}
          </span>
        )}
        {c?.languages && c.languages.length > 0 && <span>{c.languages.slice(0, 3).join(", ")}</span>}
        {(c?.calling || c?.driving) && (
          <span>
            {c.calling ?? ""}
            {c.calling && c.driving ? " · " : ""}
            {c.driving ? `drive on the ${c.driving}` : ""}
          </span>
        )}
        {intel.visa?.text && (
          <span title={`Passport Index dataset (MIT), as of ${intel.visa.updated}. Indicative: check the embassy before you book.`}>
            Visa ({intel.visa.passport} passport): {intel.visa.text}
          </span>
        )}
        {a?.warning && <span className="warn">Travel warning (German Foreign Office, {a.updated})</span>}
        {a && !a.warning && a.partial && <span className="warn">Partial travel warning for some regions (German Foreign Office)</span>}
        {intel.holidays?.[0] && (
          <span>
            Holiday there {shortDate(intel.holidays[0].date)}: {intel.holidays[0].localName}
          </span>
        )}
      </div>
      {intel.heritage && intel.heritage.length > 0 && (
        <div className="facts" title="UNESCO World Heritage Sites via Wikidata (CC0), within 60 km">
          <span>
            World Heritage nearby: {intel.heritage.map((h) => `${h.name} (${h.km} km)`).join(" · ")}
          </span>
        </div>
      )}
      {intel.places && (
        <div className="facts" title="Overture Maps places within about 5 km of the centre, CDLA-Permissive 2.0">
          {PLACE_LABELS.filter(([k]) => (intel.places?.[k] ?? 0) > 0).map(([k, label]) => (
            <span key={k}>
              <b>{count(intel.places![k]!)}</b> {label}
            </span>
          ))}
        </div>
      )}
      {summary && (
        <div className="status">
          {summary.extract.length > 320 ? `${summary.extract.slice(0, 320).replace(/\s+\S*$/, "")}…` : summary.extract}{" "}
          <a href={summary.url} target="_blank" rel="noreferrer">
            Wikivoyage ↗
          </a>{" "}
          <span className="sub">CC BY-SA</span>
        </div>
      )}
    </div>
  );
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function stops(n: number): string {
  return n ? `${n} stop${n === 1 ? "" : "s"}` : "direct";
}

function changes(n: number | undefined): string {
  return n ? `${n} change${n === 1 ? "" : "s"}` : "direct";
}

function searchAirports(airports: Airport[], q: string): Airport[] {
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  const exact = airports.filter((a) => a.iata.toLowerCase() === s);
  const rest = airports.filter(
    (a) => a.iata.toLowerCase() !== s && (a.name.toLowerCase().includes(s) || (a.city ?? "").toLowerCase().includes(s)),
  );
  const rank = (a: Airport) => (a.size === "large" ? 0 : a.size === "medium" ? 1 : 2);
  rest.sort((a, b) => rank(a) - rank(b));
  return [...exact, ...rest].slice(0, 6);
}

function Chips(p: { band: Band; onBand: (b: Band) => void; children?: React.ReactNode }) {
  return (
    <div className="chips">
      {BANDS.map((b) => (
        <button key={b.key} className={`chip${p.band === b.key ? " on" : ""}`} onClick={() => p.onBand(b.key)}>
          {b.label}
        </button>
      ))}
      {p.children}
    </div>
  );
}

export default function Panel(p: Props) {
  const [query, setQuery] = useState("");
  const hits = useMemo(() => searchAirports(p.airports, query), [p.airports, query]);
  const selected = p.selectedDest ? p.destinations.find((d) => d.airport.iata === p.selectedDest) : null;
  const place = p.selectedPlace ? p.places.find((x) => x.key === p.selectedPlace) : null;

  return (
    <aside className="panel">
      <div className="status">
        {p.origin ? (
          <>
            From <b>{p.origin.label}</b>
            {p.origin.source === "default" && " (location off, showing a default)"}
            {p.origin.source === "ip" && " (roughly, from your network)"}
            {p.origin.source === "gps" && " (GPS)"}
          </>
        ) : (
          "Finding where you are…"
        )}
      </div>

      <input
        className="search"
        placeholder="Start somewhere else: city, airport or code"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {hits.length > 0 && (
        <div>
          {hits.map((a) => (
            <div
              key={a.iata}
              className="row"
              onClick={() => {
                p.onOrigin(a);
                setQuery("");
              }}
            >
              <span className="code">{a.iata}</span>
              <span>
                <div className="name">{a.name}</div>
                <div className="sub">{[a.city, countryName(a.country)].filter(Boolean).join(", ")}</div>
              </span>
              <span className="meta">{a.size}</span>
            </div>
          ))}
        </div>
      )}

      <div className="chips">
        <button className={`chip${p.view === "all" ? " on" : ""}`} onClick={() => p.onView("all")}>
          Any way
        </button>
        <button className={`chip${p.view === "fly" ? " on" : ""}`} onClick={() => p.onView("fly")}>
          By air
        </button>
        <button className={`chip${p.view === "ground" ? " on" : ""}`} onClick={() => p.onView("ground")}>
          By train and coach
        </button>
        <button className={`chip${p.view === "trips" ? " on" : ""}`} onClick={() => p.onView("trips")}>
          Trips
        </button>
      </div>

      {p.view === "trips" && (
        <>
          <div className="status">
            Fly out, move between cities by train or coach, fly home from the last one. Ranked by value: countries and
            cities per euro and hour.
          </div>
          <div className="chips">
            {[3, 5, 7, 10].map((d) => (
              <button key={d} className={`chip${p.days === d ? " on" : ""}`} onClick={() => p.onDays(d)}>
                {d} nights
              </button>
            ))}
          </div>
          {p.homeHolidays.length > 0 && (
            <>
              <div className="status">Leave around a holiday at home:</div>
              <div className="chips">
                {p.homeHolidays.map((h) => (
                  <button
                    key={h.date}
                    className={`chip${p.around === h.date ? " on" : ""}`}
                    onClick={() => p.onAround(p.around === h.date ? null : h.date)}
                    title={h.name}
                  >
                    {shortDate(h.date)} · {h.localName}
                  </button>
                ))}
              </div>
            </>
          )}
          {(() => {
            const trip = p.selectedTrip ? p.trips?.trips.find((t) => t.id === p.selectedTrip) : null;
            if (!trip) return null;
            return (
              <>
                <h2>
                  {trip.cities.map((c) => c.name).join(" → ")} · €{trip.price}
                </h2>
                <div className="status">
                  {trip.nights} nights, {trip.outDate} to {trip.backDate}. {trip.countries} countr{trip.countries === 1 ? "y" : "ies"},{" "}
                  {trip.travelHours} h of travel door to door. Flights are cached one-way fares; train and coach tickets come on top.
                </div>
                <div>
                  {trip.legs.map((l, i) =>
                    l.kind === "fly" ? (
                      <div key={i} className="row">
                        <span className="code">FLY</span>
                        <span>
                          <div className="name">
                            {l.fromName} → {l.toName}
                          </div>
                          <div className="sub">
                            {shortDate(l.date)}
                            {l.airline ? ` · ${p.airlines[l.airline] ?? l.airline}` : ""} · {stops(l.transfers)} ·{" "}
                            <a href={l.url} target="_blank" rel="noreferrer">
                              Book ↗
                            </a>
                          </div>
                        </span>
                        <span className="meta">
                          <strong>€{l.price}</strong>~{formatDuration(l.minutes)}
                        </span>
                      </div>
                    ) : (
                      <div key={i} className="row">
                        <span className="code">{GROUND_TAG[l.mode] ?? "RID"}</span>
                        <span>
                          <div className="name">
                            {l.fromName} → {l.toName}
                          </div>
                          <div className="sub">
                            {changes(l.changes)} · {l.mode}
                          </div>
                        </span>
                        <span className="meta">
                          <strong>{formatDuration(l.minutes)}</strong>
                        </span>
                      </div>
                    ),
                  )}
                </div>
              </>
            );
          })()}
          <h2>Trips · {p.trips?.trips.length ?? 0}</h2>
          <div className="status">
            {!p.trips
              ? "Searching flights out, trains between, flights home…"
              : p.trips.status === "no-token"
                ? "Trips need cached fares: add the Travelpayouts token (SETUP §2)."
                : p.trips.status === "error"
                  ? `Trip search failed: ${p.trips.note}`
                  : p.trips.trips.length === 0
                    ? "No trip found for these nights. Try another length."
                    : ""}
          </div>
          <div className="scroll">
            {p.trips?.trips.map((t) => (
              <div
                key={t.id}
                className={`row${t.id === p.selectedTrip ? " active" : ""}`}
                onClick={() => p.onTrip(t.id === p.selectedTrip ? null : t.id)}
              >
                <span className="code">€{t.price}</span>
                <span>
                  <div className="name">{t.cities.map((c) => c.name).join(" → ")}</div>
                  <div className="sub">
                    {t.nights} nights · {t.countries} countr{t.countries === 1 ? "y" : "ies"} · {t.travelHours} h travel
                  </div>
                </span>
                <span className="meta">
                  <strong>{shortDate(t.outDate)}</strong>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {p.view === "all" && (
        <>
          {place && (
            <>
              <h2>{MODE_LABEL[place.mode]} there</h2>
              <div className="row active" onClick={() => p.onPlace(null)}>
                <span className="code">{MODE_TAG[place.mode]}</span>
                <span>
                  <div className="name">{place.name}</div>
                  <div className="sub">{place.country ? countryName(place.country) : place.ground?.mode}</div>
                </span>
                <span className="meta">
                  <strong>{formatDuration(place.minutes)}</strong>
                  {place.price != null ? `from €${place.price}` : ""}
                </span>
              </div>
              <div className="status">
                {place.mode === "plane" && place.air ? (
                  <>
                    Drive to {place.air.gateway.iata}, ~{formatDuration(flightMinutes(place.air.km))} in the air, plus airport time.
                    {place.air.fare ? (
                      <>
                        {" "}
                        €{place.air.fare.price} one way on {shortDate(place.air.fare.departureAt)}
                        {place.air.fare.airline ? ` with ${p.airlines[place.air.fare.airline] ?? place.air.fare.airline}` : ""}
                        {place.air.fareGateway && place.air.fareGateway.iata !== place.air.gateway.iata ? ` from ${place.air.fareGateway.iata}` : ""}.{" "}
                        <a href={place.air.fare.url} target="_blank" rel="noreferrer">
                          Book on Aviasales ↗
                        </a>
                      </>
                    ) : (
                      <>
                        {" "}
                        <a
                          href={`https://www.google.com/travel/flights?q=flights+from+${place.air.gateway.iata}+to+${place.air.airport.iata}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Check fares ↗
                        </a>
                      </>
                    )}
                    {place.ground ? ` Or ${formatDuration(place.ground.minutes)} by ${place.ground.mode}, ${changes(place.ground.changes)}.` : ""}
                  </>
                ) : (
                  <>
                    {changes(place.changes)} by {place.ground?.mode ?? place.mode}, in-vehicle time plus expected waits.
                    {place.air ? ` Or fly via ${place.air.gateway.iata} in ~${formatDuration(place.air.minutes)} door to door${place.price != null ? ` from €${place.price}` : ""}.` : ""}
                  </>
                )}
              </div>
              {p.intel && <PlaceIntel intel={p.intel} summary={p.summary} />}
            </>
          )}

          <h2>
            Places · {p.places.length}
            {p.places.length !== p.totalPlaces ? ` of ${p.totalPlaces}` : ""}
          </h2>
          <div className="status">
            {!p.origin
              ? ""
              : !p.reach && p.totalPlaces === 0
                ? "Searching flights, trains and coaches…"
                : `Door-to-door estimates by air, train and coach within 10 h.${p.anyFares ? " Prices are cached one-way fares." : ""}`}
          </div>
          <Chips band={p.band} onBand={p.onBand}>
            <button className={`chip${p.bigOnly ? " on" : ""}`} onClick={() => p.onBigOnly(!p.bigOnly)}>
              Big places
            </button>
            {p.anyFares && (
              <button className={`chip${p.pricedOnly ? " on" : ""}`} onClick={() => p.onPricedOnly(!p.pricedOnly)}>
                Priced only
              </button>
            )}
            {p.weatherReady && (
              <button className={`chip${p.warmOnly ? " on" : ""}`} onClick={() => p.onWarmOnly(!p.warmOnly)} title="At least 20 °C on Saturday or Sunday">
                Warm this weekend
              </button>
            )}
          </Chips>
          <div className="scroll">
            {p.places.map((x) => (
              <div
                key={x.key}
                className={`row${x.key === p.selectedPlace ? " active" : ""}`}
                onClick={() => p.onPlace(x.key === p.selectedPlace ? null : x.key)}
              >
                <span className="code">{MODE_TAG[x.mode]}</span>
                <span>
                  <div className="name">{x.name}</div>
                  <div className="sub">
                    {x.mode === "plane"
                      ? `via ${x.air?.gateway.iata}${x.country ? ` · ${countryName(x.country)}` : ""}`
                      : `${changes(x.changes)}${x.country ? ` · ${countryName(x.country)}` : ""}`}
                  </div>
                </span>
                <span className="meta">
                  <strong>{formatDuration(x.minutes)}</strong>
                  {x.price != null ? `from €${x.price}` : ""}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {p.view === "ground" && (
        <>
          <h2>Nearest stations</h2>
          <div>
            {!p.reach && <div className="status">Searching the rail and coach network…</div>}
            {p.reach?.starts.slice(0, 4).map((s) => (
              <div key={s.id} className="row">
                <span className="code">{formatDuration(s.minutes)}</span>
                <span>
                  <div className="name">{s.name}</div>
                  <div className="sub">drive, estimated</div>
                </span>
                <span className="meta" />
              </div>
            ))}
            {p.reach && p.reach.starts.length === 0 && (
              <div className="status">No station within 40 km in the feeds loaded so far.</div>
            )}
          </div>

          <h2>Places · {p.reachShown.length}</h2>
          <div className="status">
            {p.reach ? `${p.reach.reached.length} stations within 10 h. In-vehicle time plus an expected wait per leg, not a timetable.` : ""}
          </div>
          <Chips band={p.band} onBand={p.onBand} />
          <div className="scroll">
            {p.reachShown.map((s) => (
              <div
                key={s.id}
                className={`row${s.id === p.selectedStation ? " active" : ""}`}
                onClick={() => p.onStation(s.id === p.selectedStation ? null : s.id)}
              >
                <span className="code">{MODE_TAG[s.mode] ?? s.mode}</span>
                <span>
                  <div className="name">{s.name}</div>
                  <div className="sub">{changes(s.changes)}</div>
                </span>
                <span className="meta">
                  <strong>{formatDuration(s.minutes)}</strong>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {p.view === "fly" && (
        <>
          <h2>Gateways</h2>
          <div>
            {p.gateways.length === 0 && <div className="status">No airport with scheduled flights within reach.</div>}
            {p.gateways.map((g) => (
              <div
                key={g.airport.iata}
                className={`row${g.airport.iata === p.gatewayIata ? " active" : ""}`}
                onClick={() => p.onGateway(g.airport.iata)}
              >
                <span className="code">{g.airport.iata}</span>
                <span>
                  <div className="name">{g.airport.name}</div>
                  <div className="sub">{[g.airport.city, countryName(g.airport.country)].filter(Boolean).join(", ")}</div>
                </span>
                <span className="meta">
                  <strong>{formatDuration(g.driveMin)}</strong>
                  {Math.round(g.km)} km · {p.routeCounts[g.airport.iata] ?? 0} routes
                </span>
              </div>
            ))}
          </div>

          {selected ? (
            <>
              <h2>Destination</h2>
              <div className="row active" onClick={() => p.onDest(null)}>
                <span className="code">{selected.airport.iata}</span>
                <span>
                  <div className="name">{selected.airport.name}</div>
                  <div className="sub">{[selected.airport.city, countryName(selected.airport.country)].filter(Boolean).join(", ")}</div>
                </span>
                <span className="meta">
                  {selected.fare ? (
                    <>
                      <strong>from €{selected.fare.price}</strong>
                      {shortDate(selected.fare.departureAt)} · {stops(selected.fare.transfers)}
                    </>
                  ) : (
                    <>
                      <strong>~{formatDuration(flightMinutes(selected.km))}</strong>
                      {Math.round(selected.km)} km
                    </>
                  )}
                </span>
              </div>
              {selected.fare ? (
                <div className="status">
                  €{selected.fare.price} one way on {shortDate(selected.fare.departureAt)}
                  {selected.fare.airline ? ` with ${p.airlines[selected.fare.airline] ?? selected.fare.airline}` : ""}, {stops(selected.fare.transfers)}, ~
                  {formatDuration(selected.fare.durationMin ?? flightMinutes(selected.km))}. Cached from recent Aviasales searches; the live price is on
                  the booking page.{" "}
                  <a href={selected.fare.url} target="_blank" rel="noreferrer">
                    Book on Aviasales ↗
                  </a>
                </div>
              ) : (
                <div className="status">
                  {selected.airlines
                    ? `${selected.airlines} airline${selected.airlines === 1 ? "" : "s"} flew ${selected.from.iata} → ${selected.airport.iata} in the 2014 network. `
                    : ""}
                  No cached fare for this route right now.{" "}
                  <a
                    href={`https://www.google.com/travel/flights?q=flights+from+${selected.from.iata}+to+${selected.airport.iata}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Check fares ↗
                  </a>
                </div>
              )}
            </>
          ) : null}

          <h2>
            Destinations · {p.destinations.length}
            {p.destinations.length !== p.totalDestinations ? ` of ${p.totalDestinations}` : ""}
          </h2>
          <div className="status">
            {p.fares === null
              ? "Checking fares…"
              : p.fares.status === "ok"
                ? `Cheapest cached one-way fares, next 3 months: ${p.fares.fares.length} priced.`
                : p.fares.status === "no-token"
                  ? "No fares yet: add the Travelpayouts token (SETUP §2)."
                  : `Fares unavailable: ${p.fares.note ?? "error"}`}
          </div>
          <Chips band={p.band} onBand={p.onBand}>
            {p.fares?.status === "ok" && (
              <button className={`chip${p.pricedOnly ? " on" : ""}`} onClick={() => p.onPricedOnly(!p.pricedOnly)}>
                Priced only
              </button>
            )}
          </Chips>
          <div className="scroll">
            {p.destinations.map((d) => (
              <div
                key={d.airport.iata}
                className={`row${d.airport.iata === p.selectedDest ? " active" : ""}`}
                onClick={() => p.onDest(d.airport.iata)}
              >
                <span className="code">{d.airport.iata}</span>
                <span>
                  <div className="name">{d.airport.city ?? d.airport.name}</div>
                  <div className="sub">{countryName(d.airport.country)}</div>
                </span>
                <span className="meta">
                  {d.fare ? (
                    <>
                      <strong>from €{d.fare.price}</strong>
                      {shortDate(d.fare.departureAt)} · {stops(d.fare.transfers)}
                    </>
                  ) : (
                    <>
                      <strong>~{formatDuration(flightMinutes(d.km))}</strong>
                      {Math.round(d.km)} km
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

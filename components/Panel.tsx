"use client";

import { useMemo, useState } from "react";
import { flightMinutes, formatDuration } from "@/lib/geo";
import type { Airport, Destination, FaresResponse, Gateway } from "@/lib/types";
import { countryName, type Origin } from "./Globe";

export type Band = "all" | "short" | "medium" | "long";
export const BANDS: { key: Band; label: string; test: (min: number) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "short", label: "Under 2h", test: (m) => m < 120 },
  { key: "medium", label: "2 to 5h", test: (m) => m >= 120 && m < 300 },
  { key: "long", label: "5h and more", test: (m) => m >= 300 },
];

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
  pricedOnly: boolean;
  onPricedOnly: (v: boolean) => void;
};

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function stops(n: number): string {
  return n ? `${n} stop${n === 1 ? "" : "s"}` : "direct";
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

export default function Panel(p: Props) {
  const [query, setQuery] = useState("");
  const hits = useMemo(() => searchAirports(p.airports, query), [p.airports, query]);
  const selected = p.selectedDest ? p.destinations.find((d) => d.airport.iata === p.selectedDest) : null;

  return (
    <aside className="panel">
      <div className="status">
        {p.origin ? (
          <>
            From <b>{p.origin.label}</b>
            {p.origin.source === "default" && " (location off, showing a default)"}
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
              {selected.fare.airline ? ` with ${selected.fare.airline}` : ""}, {stops(selected.fare.transfers)}, ~
              {formatDuration(selected.fare.durationMin ?? flightMinutes(selected.km))}. Cached from recent Aviasales searches; the live price is on the
              booking page.{" "}
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
      <div className="chips">
        {BANDS.map((b) => (
          <button key={b.key} className={`chip${p.band === b.key ? " on" : ""}`} onClick={() => p.onBand(b.key)}>
            {b.label}
          </button>
        ))}
        {p.fares?.status === "ok" && (
          <button className={`chip${p.pricedOnly ? " on" : ""}`} onClick={() => p.onPricedOnly(!p.pricedOnly)}>
            Priced only
          </button>
        )}
      </div>
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
    </aside>
  );
}

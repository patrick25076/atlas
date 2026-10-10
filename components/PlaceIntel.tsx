"use client";

import { sunTimes, tzOffsetMinutes } from "@/lib/sun";
import type { PlaceSummary } from "@/app/api/place/route";
import type { CityPlaces, CountryInfo, Holiday, WeatherDay } from "@/lib/types";
import { count, people, rate, shortDate, weekday } from "@/lib/format";

/** Everything we know about the selected place's city and country. */
export type Intel = {
  code?: string;
  tz?: string;
  lat?: number;
  lon?: number;
  countryCode?: string;
  country?: CountryInfo;
  weather?: WeatherDay[];
  sea?: number;
  holidays?: Holiday[];
  places?: CityPlaces;
  pop?: number;
  heritage?: { name: string; km: number }[];
  visa?: { passport: string; text: string | null; updated: string };
  events?: { name: string; date: string; venue?: string; kind?: string; url: string }[];
  fame?: [number, number, number];
};

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

export default function PlaceIntel({ intel, summary }: { intel: Intel; summary: PlaceSummary | null }) {
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
        shift = `${h > 0 ? "+" : ""}${Number.isInteger(h) ? h : h.toFixed(1)} h`;
      }
    }
  } catch {
    time = null;
  }
  const a = c?.advisory;
  return (
    <div className="intel">
      {intel.weather && intel.weather.length > 0 && (
        <div className="section">
          <h2>This week there</h2>
          <div className="wx" title="MET Norway forecast, CC BY 4.0">
            {intel.weather.slice(0, 7).map((d) => (
              <div key={d.d} className="wxday">
                <span>{weekday(d.d)}</span>
                <span className="wxg">{glyph(d.sym)}</span>
                <span className="wxt">{d.tmax}°</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {intel.events && intel.events.length > 0 && (
        <div className="section">
          <h2>What&apos;s on</h2>
          <div>
            {intel.events.slice(0, 5).map((e) => (
              <a key={e.url + e.date} className="row" href={e.url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
                <span className="code">{shortDate(e.date)}</span>
                <span>
                  <div className="name">{e.name}</div>
                  <div className="sub">{[e.kind, e.venue].filter(Boolean).join(" · ")}</div>
                </span>
                <span className="meta">↗</span>
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="section">
        <h2>Good to know</h2>
        <div className="facts">
          {a?.warning && (
            <div className="fact warn wide">
              <b>Travel warning</b>German Foreign Office, {a.updated}
            </div>
          )}
          {a && !a.warning && a.partial && (
            <div className="fact warn wide">
              <b>Partial travel warning</b>some regions, German Foreign Office
            </div>
          )}
          {intel.visa?.text && (
            <div className="fact wide" title={`Passport Index dataset (MIT), as of ${intel.visa.updated}. Indicative: check the embassy before you book.`}>
              <b>Visa, {intel.visa.passport} passport</b>
              {intel.visa.text}
            </div>
          )}
          {time && (
            <div className="fact">
              <b>{time} there</b>
              {shift ? `${shift} from you` : "same time as you"}
            </div>
          )}
          {daylight && (
            <div className="fact">
              <b>Daylight</b>
              {daylight}
            </div>
          )}
          {c?.currency && (
            <div className="fact">
              <b>{c.currency}</b>
              {c.rate && c.currency !== "EUR" ? `1 € = ${rate(c.rate)} ${c.currency}` : "euro"}
            </div>
          )}
          {intel.sea != null && (
            <div className="fact" title="MET Norway ocean forecast at the nearest port">
              <b>Sea {intel.sea}°</b>right now
            </div>
          )}
          {c?.plugs && c.plugs.length > 0 && (
            <div className="fact">
              <b>Plugs {c.plugs.slice(0, 3).join(", ")}</b>
              {c.voltage ? `${c.voltage} V` : ""}
            </div>
          )}
          {c?.languages && c.languages.length > 0 && (
            <div className="fact">
              <b>Spoken</b>
              {c.languages.slice(0, 3).join(", ")}
            </div>
          )}
          {intel.pop ? (
            <div className="fact">
              <b>{people(intel.pop)} people</b>
              {intel.fame && intel.fame[0] > 0 ? `${count(intel.fame[0])} looked it up last year` : "city"}
            </div>
          ) : null}
          {(c?.calling || c?.driving) && (
            <div className="fact">
              <b>{c.calling ?? "Driving"}</b>
              {c.driving ? `drive on the ${c.driving}` : ""}
            </div>
          )}
          {intel.holidays?.[0] && (
            <div className="fact wide">
              <b>Holiday there {shortDate(intel.holidays[0].date)}</b>
              {intel.holidays[0].localName}
            </div>
          )}
          {intel.heritage && intel.heritage.length > 0 && (
            <div className="fact wide" title="UNESCO World Heritage via Wikidata (CC0), within 60 km">
              <b>World Heritage nearby</b>
              {intel.heritage.map((h) => `${h.name} (${h.km} km)`).join(" · ")}
            </div>
          )}
        </div>
        {intel.places && (
          <div className="counts" title="Overture Maps places within about 5 km of the centre, CDLA-Permissive 2.0">
            {PLACE_LABELS.filter(([k]) => (intel.places?.[k] ?? 0) > 0).map(([k, label]) => (
              <span key={k}>
                <b>{count(intel.places![k]!)}</b> {label}
              </span>
            ))}
          </div>
        )}
      </div>

      {summary && (
        <div className="section">
          <h2>In a paragraph</h2>
          <p className="para" style={{ margin: 0 }}>
            {summary.extract.length > 420 ? `${summary.extract.slice(0, 420).replace(/\s+\S*$/, "")}…` : summary.extract}{" "}
            <a href={summary.url} target="_blank" rel="noreferrer">
              Wikivoyage ↗
            </a>{" "}
            <span className="muted">CC BY-SA</span>
          </p>
        </div>
      )}
    </div>
  );
}

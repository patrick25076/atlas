"use client";

import { useEffect, useState } from "react";
import { countryName, dateRange, euro } from "@/lib/format";
import { filterByCountry } from "@/lib/been";

// A strip for the Deals tab: the cities where tonight's cheapest decent hotel sits well under
// its own usual price (GET /api/hotel-deals, from our nightly LiteAPI snapshots). It renders
// nothing until the history is deep enough to call something a deal, and nothing at all when
// the answer is anything but a list of deals.

type HotelDeal = {
  code: string;
  city: string;
  country: string;
  hotel: string;
  price: number;
  typical: number;
  below: number;
  stars?: number;
  rating?: number;
  checkin?: string;
  checkout?: string;
  /** Only some deals carry a booking page; a card without one is plain text. */
  url?: string;
};
type HotelDealsResult = {
  status: "ok" | "warming-up" | "no-data" | "no-store";
  note?: string;
  snapshots: number;
  latest?: { date: string; checkin: string; checkout: string; cities: number };
  deals: HotelDeal[];
};

// The Deals tab unmounts on every tab switch; the answer is kept for the page's lifetime so
// the strip does not ask again each time (the route is cached an hour anyway).
let cached: HotelDealsResult | undefined;

/** exclude: ISO2 countries the visitor does not want to stay in (the Been list with "only new" on). */
export default function HotelDeals({ exclude = [] }: { exclude?: string[] }) {
  const [res, setRes] = useState<HotelDealsResult | null>(cached ?? null);
  useEffect(() => {
    if (cached !== undefined) return;
    const ctrl = new AbortController();
    fetch("/api/hotel-deals", { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<HotelDealsResult>) : null))
      .then((j) => {
        // Only a real answer is kept for the page's lifetime; a non-2xx or unparsable
        // response leaves the cache empty so the next Deals visit asks again.
        if (j && typeof j.status === "string") cached = j;
        setRes(j);
      })
      // An aborted fetch (the tab changed) or a network error is simply no strip, and
      // nothing is cached so a later mount retries.
      .catch(() => {});
    return () => ctrl.abort();
  }, []);
  // A hotel night is a stay, so a deal in a country on the Been list is left out like a flight.
  const deals = res && res.status === "ok" ? filterByCountry(res.deals, exclude) : [];
  if (!res || res.status !== "ok" || !deals.length) return null;
  const stay = res.latest ? dateRange(res.latest.checkin, res.latest.checkout) : null;
  return (
    <div className="hoteldeals">
      <div className="headline">
        <h2>Hotels under their usual price</h2>
        {stay && <span className="sub">{stay}</span>}
      </div>
      <div className="hdrow">
        {deals.slice(0, 12).map((d) => {
          const body = (
            <>
              <b>{d.city}</b>
              <span className="sub" title={d.hotel}>
                {d.hotel}
              </span>
              <span className="hdprice">
                {euro(d.price)} <small>a night</small>
              </span>
              <span className="sub">
                typical {euro(d.typical)} · <em>{d.below}% below</em>
              </span>
            </>
          );
          const key = `${d.code}|${d.hotel}`;
          return d.url ? (
            <a key={key} className="hdcard" href={d.url} target="_blank" rel="noreferrer" title={`${d.hotel}, ${d.city}, ${countryName(d.country)}`}>
              {body}
            </a>
          ) : (
            <div key={key} className="hdcard" title={`${d.hotel}, ${d.city}, ${countryName(d.country)}`}>
              {body}
            </div>
          );
        })}
      </div>
      <div className="status muted">{res.note ?? `The cheapest decent hotel in each city for a standard weekend about four weeks out, against its own median of the last ${res.snapshots} nights.`}</div>
    </div>
  );
}

"use client";

// "How Atlas works": six short sections on the one search, opened from the "?" in the top bar
// or "/help" on the command line. Each section says what it does in plain words and gives one
// thing to try; a try that is a command line runs it (through the 'atlas:command' window
// event, the same door the command line uses) and closes the guide. Scrolls inside itself,
// full screen on a phone.

import { useEffect, useRef } from "react";

type Section = {
  id: string;
  title: string;
  body: string[];
  /** A command line to run, or null when the try is something to do with the hands. */
  run?: string;
  /** The try, in words. */
  tryText: string;
  /** What running the try spends of the day's live Kiwi searches, said next to it so a reader exploring the guide is not surprised. */
  cost?: string;
};

const SECTIONS: Section[] = [
  {
    id: "search",
    title: "One search",
    body: [
      "The Search tab is the whole app: From (your place and its airports), To (anywhere, a city, a country or a region), When (exact dates, a flexible window with a day that must be in it, a month, or anytime) and Nights. Press Search.",
      "You never pick an engine. Atlas asks the nightly price graph first, then live fares, and puts every kind of trip in one list: there and back, one way, two cities, a loop, a long stay.",
      "The command line in the top bar fills the same search from words. Press / or Ctrl+K to jump into it.",
    ],
    run: "getaways this weekend",
    tryText: "getaways this weekend",
  },
  {
    id: "results",
    title: "The list and the globe",
    body: [
      "Results arrive as they are found, cheapest first (your trip style can switch to balanced or comfort). Each card shows the price, the route with its planes and trains, the dates, the nights in each place and the hours of travel.",
      "The globe shows the same list as price tags. Hover a card or a tag to see that trip's route; the chips under the bar (direct only, shorter legs, cities, trains, events on, new countries, a price cap) filter at once, without a new search.",
    ],
    tryText: "Hover a card, then a price tag on the globe.",
  },
  {
    id: "trip",
    title: "The trip page",
    body: [
      "Tap any card or tag. The trip page has every leg with its own booking link, ways home on the days around, hotels for your dates, what is on while you are there, and the sights and food of each place.",
      "Make it a plan turns the trip into a day by day itinerary you can save, share or put in your calendar. Prices are checked on the booking page; train, coach and some fares are estimates and say so.",
    ],
    tryText: "Open the first result, then press Make it a plan.",
  },
  {
    id: "advanced",
    title: "Advanced, Trip style and Been",
    body: [
      "Advanced, under the bar, holds the long trips: the trip shape (one place, two cities, a loop of three or more, a long stay), a wild loop through a far region, a long stay of one to six months, and a group of friends from different airports.",
      "Trip style in the top bar sets how you travel, once: 2 to 3 nights in each place by default, cheapest or comfort, places to avoid, trains between places. Been marks the countries you know; with only new countries on, no trip sleeps there.",
    ],
    run: "/wild balkans 10",
    tryText: "/wild balkans 10",
    cost: "runs a live search, about 14 fare searches",
  },
  {
    id: "ask",
    title: "Ask",
    body: [
      "Ask in your own words. The chat knows where you are, your airports, Been and your trip style, and works on the same search: make it direct, add a city, cheaper, what about November. It shows the same trip cards and may ask you to tap a region, a date or a place on the globe.",
    ],
    tryText: "Open Ask and type: a cheap 5 day trip with good food in November.",
  },
  {
    id: "mytrips",
    title: "My trips",
    body: [
      "Your saved itineraries and your last ten searches, kept in this browser. Tap a search to run it again with the prices of the day.",
      "Old links to Deals, Explore or Trips still work: they open the search that answers the same question.",
    ],
    tryText: "Open My trips after a search.",
  },
];

export default function Guide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    box.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;

  const run = (text: string) => {
    onClose();
    window.dispatchEvent(new CustomEvent("atlas:command", { detail: { text } }));
  };

  return (
    <div className="guidewrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="guide" role="dialog" aria-modal="true" aria-labelledby="guide-title" tabIndex={-1}>
        <header>
          <h2 id="guide-title">How Atlas works</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close the guide">
            ×
          </button>
        </header>
        <nav className="guidenav" aria-label="Sections">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#guide-${s.id}`} onClick={(e) => {
              e.preventDefault();
              document.getElementById(`guide-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}>
              {s.title}
            </a>
          ))}
        </nav>
        <div className="guidebody">
          {SECTIONS.map((s) => (
            <section key={s.id} id={`guide-${s.id}`}>
              <h3>{s.title}</h3>
              {s.body.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
              <div className="guidetry">
                <span className="k">Try this</span>
                {s.run ? (
                  <>
                    <button type="button" className="linkbtn mono" onClick={() => run(s.run!)}>
                      {s.tryText}
                    </button>
                    {s.cost && <span className="muted"> ({s.cost})</span>}
                  </>
                ) : (
                  <span className={s.id === "cli" ? "mono" : ""}>{s.tryText}</span>
                )}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

"use client";

// "How Atlas works": a short guide to every feature, opened from the "?" in the top bar or
// "/help" on the command line. Each section says what the feature does in plain words and
// gives one thing to try; a try that is a command line runs it (through the 'atlas:command'
// window event, the same door the command line uses) and closes the guide. Scrolls inside
// itself, full screen on a phone.

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
    id: "command",
    title: "The command line",
    body: [
      "One box for everything. Type a route, a month, a loop, a place or a question; the list under the box shows what your words could mean, best guess first. Up and Down choose, Enter runs, Esc closes.",
      "Press / or Ctrl+K from anywhere to jump into it. A question it cannot place goes to the chat.",
    ],
    run: "Brasov to Lisbon",
    tryText: "Brasov to Lisbon",
  },
  {
    id: "deals",
    title: "Deals and the custom search",
    body: [
      "The Deals tab lists the cheapest return trips from your airports for the next six weeks, searched every night. Each price is also a tag on the globe; tap one to open it.",
      "The custom search looks over any period from several airports: nights, a must-have date, direct only, a longest flight, a region. It can also let the way home leave from another airport (open jaw), and try hidden-city tickets.",
      "Split tickets: some of the cheapest trips are two one-way tickets instead of one return, sometimes flying into one city and home from another (the card says \"In to Porto, home from Lisbon\" and how long the trip between them takes by land). They are separate bookings: if the first flight is late, the second airline owes you nothing, so leave a margin.",
    ],
    tryText: "Open Deals, then hover a price on the globe to see where it goes.",
  },
  {
    id: "explore",
    title: "Explore and place pages",
    body: [
      "Explore shows every place you can reach: by plane in one hop, and by train or coach on the ground graph of 16,000 stations. Tap a city for its page: the sights, food, the best months, events, hotels and how to get there.",
    ],
    run: "/place Porto",
    tryText: "/place Porto",
  },
  {
    id: "ab",
    title: "Get there (A to B)",
    body: [
      "The cheapest and the fastest way between two places, every kind of ticket: a nearby airport, a train to a bigger airport, two tickets through a hub, a different airport home, or no flight at all.",
      "The first answer comes from the fare memory and the timetables in a second, with no live search. Search live fares spends up to twelve searches for more. The order follows your trip style: cheapest, balanced or comfort.",
    ],
    run: "to Lisbon 14 Nov 4 nights",
    tryText: "to Lisbon 14 Nov 4 nights",
  },
  {
    id: "events",
    title: "Events worth flying for",
    body: ["Festivals, matches, concerts, seasons and food fairs in a window, each on the globe with the cheapest fare there that the boards already know. Tap one for its dates, the fare and an itinerary around it."],
    run: "events in february",
    tryText: "events in february",
  },
  {
    id: "chat",
    title: "The chat",
    body: [
      "Ask in your own words. The chat knows where you are, your airports, your Been list and your trip style, and uses the same engines as the rest of the app: its answers come back as cards, and the globe draws them.",
      "It may ask you to tap a region, a date or a place on the globe; the globe passes your tap back.",
    ],
    tryText: "Open the Ask tab and type: a cheap 5 day trip with good food in November.",
  },
  {
    id: "smart",
    title: "Smart loops (the graph walk)",
    body: [
      "This is the way you would search by hand. From where you are, one explore search finds the cheapest places to fly to. From each of those it looks at the cheapest next hops: flights, and trains and coaches from the ground graph (a shortest path search over the timetables) when they are cheap and under about five and a half hours. Then the cheapest way home, to any of your airports, not only the one you left from.",
      "It keeps the few best partial trips at every step and draws its thinking on the globe: every price it looked at, the cities it chose, and the loops as they close. Fares already in the fare memory cost no search.",
      "Nights a stop follow your trip style. More live searches find more; zero answers from what is already known.",
    ],
    run: "3 cities in 6 days, not Germany, unique",
    tryText: "3 cities in 6 days, not Germany, unique",
    cost: "runs a live search, up to 12 fare searches",
  },
  {
    id: "wild",
    title: "Wild loops",
    body: [
      "A long loop through a far region or your own list of countries: the way in, many stops, the way home, living costs per day, visas and a second opinion that scores the trip.",
      "It is built with the same graph walk as Smart loops, aimed at the region: the first flight goes straight there, every later hop stays inside it, and it stays as long in each place as your trip style says (2 to 3 nights unless you change it). The Classic builder toggle uses the older country by country chain instead.",
      "A loop holds at most 16 stops. A trip too long for your nights a place (more than about 48 nights at 3 a place) stays a little longer in each, and the form says how long before you build.",
      "Plan the days turns the loop into a day by day plan.",
    ],
    run: "/wild balkans 10",
    tryText: "/wild balkans 10",
    cost: "runs a live search, about 14 fare searches",
  },
  {
    id: "longstay",
    title: "Long stay",
    body: ["One base for a month or more: the best value cities of a region, with flights in and out, rent and living costs from price levels, side trips, the climate and the visa."],
    run: "/stay thailand 2 months",
    tryText: "/stay thailand 2 months",
  },
  {
    id: "group",
    title: "Group",
    body: ["Friends in different cities meeting somewhere cheap: add each person with their airports and free dates, and Atlas finds the dates that suit everyone and the city that costs the group least in total."],
    tryText: "Trips, then Group: add a friend and their airport.",
  },
  {
    id: "been",
    title: "Been",
    body: ["Mark the countries you already know. With Only new countries on, no search lands or sleeps there (a connection through them is still fine); with revisits on, deals there just get a small tag."],
    tryText: "Open Been in the top bar and add a country.",
  },
  {
    id: "style",
    title: "Trip style",
    body: [
      "How you like to travel, set once: nights in each place (2 to 3 by default), pace, cheapest or comfort, popular or unique places, countries or groups to never stop in (nordics, dach), the longest flight, and whether trains and coaches between places are welcome.",
      "Every builder starts from it: Wild loops, Smart loops, Short loops, A to B, the command line and the chat. A form can still change any of it for one search.",
    ],
    tryText: "Open Trip style in the top bar and set 2 to 3 nights.",
  },
  {
    id: "itinerary",
    title: "Itineraries",
    body: [
      "Any result (a deal, a route, a loop, an event) can become a day by day plan with the food, the sights, what is on those days and the costs. Save it to keep it in this browser, Share copies a link anyone can open, and Calendar adds the days to your calendar.",
    ],
    run: "itinerary Lisbon 3 nights from 14 Nov",
    tryText: "itinerary Lisbon 3 nights from 14 Nov",
  },
  {
    id: "prices",
    title: "Where the prices come from",
    body: [
      "Tonight's boards: the cheapest returns from about 150 airports, searched every night on Kiwi.com. The fare memory: every fare any search has seen, so a question asked before costs nothing. Live searches: Kiwi.com at the moment you ask, a limited number a day, which is why the forms say how many they spend.",
      "Train and coach prices, living costs and a few fares are estimates; they are marked with a ~ or the word estimated. Always check the price on the booking page.",
    ],
    tryText: "Open a deal and look at the line under its price.",
  },
  {
    id: "cli",
    title: "The terminal",
    body: ["The same command language runs in a terminal for whoever has the code: pnpm atlas followed by the words, for example pnpm atlas Brasov to Lisbon. It prints the tables the chat would have seen."],
    tryText: "pnpm atlas loop from Brasov 6 days",
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

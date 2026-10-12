# Atlas: data inventory

_Counted on 2026-10-10 from `public/data` and the Blob store. Regions are rough boxes by
coordinates; "cities" are the Travelpayouts city codes with at least one airport on the globe,
"cities with a real airport" those with a large or medium one._

## Coverage per region

| Region | Cities | with a real airport | Weather (7 days) | Sea temp | Place counts | Climate normals | Fame | Heritage sites | Stations | Ferries | Nightly boards |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Europe | 486 | 460 | 460 | 87 | 460 | 268 | 422 | 862 | 12,723 | 3,275 | 60 |
| North America | 832 | 718 | 718 | 0 | 704 | 382 | 646 | 147 | 1,388 | 0 | 30 |
| Asia | 750 | 675 | 675 | 0 | 631 | 367 | 613 | 293 | 1 | 0 | 24 |
| Middle East and Caucasus | 193 | 184 | 184 | 0 | 178 | 90 | 167 | 192 | 202 | 259 | 14 |
| South America | 320 | 282 | 282 | 0 | 266 | 154 | 258 | 201 | 0 | 0 | 5 |
| Africa | 246 | 230 | 230 | 0 | 220 | 107 | 208 | 134 | 34 | 30 | 7 |
| Oceania | 293 | 219 | 219 | 0 | 211 | 110 | 200 | 46 | 0 | 0 | 6 |
| Total | 3,159 | 2,805 | 2,805 | 87 | 2,707 | 1,496 | 2,549 | 1,887 | 12,959 | 3,564 | 146 |

Country-level layers, worldwide: 253 countries with a name and currency, 104 with today's
rate per euro (the ECB list), 222 with plug types and voltage, 200 with a travel advisory,
204 with public holidays (2,878 holidays over 400 days), 199 passports × 199 destinations of
visa rules, 193 countries with a World Bank price level (living costs), 34,156 towns with
population (GeoNames).

## Every layer

| Layer | File | Source and licence | Refresh | Used by |
|---|---|---|---|---|
| Airports | `airports.json` (4,008; 1,150 large, 2,094 medium) | OurAirports, public domain | daily | gateways, boards, every route |
| Cities | `cities.json` (3,159) | Travelpayouts cities + airports (free for partners) | daily | everything; city code → name, coordinates, time zone, population, airports |
| Routes | `routes-openflights.json` (37,594) | OpenFlights, ODbL, frozen 2014 | never | hub degree (how big an airport is), Explore arcs; indicative only |
| Airlines | `airlines.json` (1,159) | Travelpayouts, free | daily | carrier names |
| Countries | `countries.json` (253) | Travelpayouts; Frankfurter ECB rates; Wikidata CC0 (plugs, languages, calling code, driving side); German Federal Foreign Office advisories | daily | place card, safety filters, costs |
| Holidays | `holidays.json` (204 countries) | Nager.Date, open source | daily | trip-date chips, the next holiday there |
| Weather | `weather.json` (2,805 cities, 87 sea) | MET Norway locationforecast and oceanforecast, CC BY 4.0 | daily | the week's weather, "warm this weekend", coastal flag |
| Climate normals | `climate.json` (1,496 cities, growing) | NASA POWER 2001 to 2025 (free, no key) | monthly | best months, long stays, the chat |
| Place counts | `city-places.json` (2,707) | Overture Maps places, CDLA-Permissive 2.0 | monthly | how much there is (restaurants, bars, culture), hidden gems |
| Towns | `towns.json` (34,156) | GeoNames cities15000, CC BY 4.0 | weekly | populations, station towns |
| World Heritage | `heritage.json` (1,887) | Wikidata, CC0 | monthly | badges, hidden gems, the card |
| Visa | `visa.json` (199 × 199) | Passport Index dataset (MIT), February 2026, labelled indicative | monthly | visa line per stop |
| Fame | `fame.json` (2,549) | Wikipedia pageviews + Wikivoyage listings, CC BY-SA | monthly | hidden gems, worth of a stop |
| Costs | `costs.json` (193 countries) | World Bank price level index (CC BY 4.0) | monthly | living cost per day, rent |
| Ground graph | `ground-graph.json` (23,435 stations, 765k edges, 17.1 MB on 2026-10-12) | GTFS: gtfs.de long-distance (CC BY 4.0), CFR and private RO operators (OGL-ROU), SNCF (ODbL), Eurostar (Etalab 2.0), FlixBus EU (ODbL, transport.data.gouv.fr), FlixBus and Greyhound US (Flix open GTFS, gtfs.gis.flix.tech, no explicit licence: **permission pending**, ask open-data@flixbus.com, SETUP §9), Renfe, SNCB (SNCB open data), Irish Rail (NTA open data), VIA Rail Canada (VIA Rail developer terms, via the Mobility Database mdb-735), Amtrak (public GTFS, no explicit licence), KTM Malaysia (data.gov.my terms), Thailand's national feed (OTP, CC BY 4.0; intercity trains, coaches and island ferries only), and since 2026-10-12 the national railways of Poland (PKP PLK re-use terms, via mkuran.pl), Czechia (Správa železnic, no licence stated; CC0 conversion by motis.obehy.cz), Slovakia (ŽSR, CC BY 1.0), Croatia (HŽPP, data.gov.hr, no licence text) and Bulgaria (BDZ, CC BY 4.0 by livetransport.eu); the exact wording per feed is in `scripts/ingest/feeds.ts` and shown in the app; estimates, not timetables | weekly | Explore reach, combos, side trips, border hops |
| Ferries | `ferries.json` (3,564 crossings) | Overture transportation water segments, estimated crossings | monthly | Explore, ground graph |
| Deals (fallback) | `deals.json` (2,201) | Kiwi.com, the seven Romanian airports | nightly (git) | fallback when no Blob board exists |
| One-way fares | `oneway.json` (4,201) | Kiwi.com, Romanian airports | weekly | Trips tab loops |
| Boards | Blob `boards/*` (146 + 9 monthly) | Kiwi.com, nightly from GitHub, live for any other airport | nightly | Deals tab, the agent, purpose trips |
| Wild trips, plans | Blob `wild/*`, `plan/*` | built live, kept a day / three days | on demand | Wild tab, the chat |
| Hotel snapshots | Blob `hotels/*`, Postgres `hotel_prices` | LiteAPI, 80 cities a night | nightly | hotel deals |
| Fare memory | Postgres `fares` | every Kiwi itinerary any search saw | live | scan, insights, history |
| Events | live, `lib/events/sources.ts` | 20 cities' own open feeds (ODbL, CC BY, Licence Ouverte, city terms), `docs/events-sources.md` | live, cached 3 h | deal page, the chat, purpose trips |
| Sights, guides | live, `/api/sights`, `/api/place` | Wikivoyage, CC BY-SA 4.0, attributed | live, cached a day | deal page, the planner |
| Restaurants | live, `lib/foursquare.ts` | Foursquare Places (keyed, free tier) | live, cached a day | deal page, plans, the chat |
| Hotels | live, `lib/liteapi.ts` | LiteAPI (keyed, production) | live, cached 30 min | deal page, the chat, snapshots |
| Web research | live, `lib/tavily.ts` | Tavily (keyed, free tier) | live, cached a day | the planner, the chat |

## What is missing, by region

- **Everywhere outside Europe**: ground transport. The graph is 12,723 European stations and
  1,388 North American ones (VIA Rail, FlixBus US) as counted on 2026-10-10; Amtrak, KTM
  Malaysia and Thailand's intercity feed were added to `feeds.ts` in round two and enter the
  graph on the next weekly run (the counts above predate them). South America, Africa and
  Oceania have none, so combos, border hops and side trips there are distance estimates. Sea
  temperature exists only where MET Norway's ocean model reaches (Nordic and Baltic, 87
  cities): the Mediterranean, the tropics and every other coast say nothing.
- **Rail in Central and Eastern Europe** (checked 2026-10-12). Added: Poland (all 13 operators
  in PKP PLK's timetable, 2,941 new stations: Warsaw to Gdansk is now the 2 h 25 train, not a
  5 h coach from Modlin), Czechia (2,647), Slovakia (752), Croatia (445), Bulgaria (651, named in
  English from the feed's translations). Still missing: **Hungary**, whose MÁV GTFS (CC0)
  needs a registered account at mavcsoport.hu (only cross-border CFR, ÖBB and FlixTrain runs
  reach Budapest today); **Austria**, ÖBB's CC BY 4.0 feed behind a click-to-accept page
  (SETUP §9); **Italy**, no national Trenitalia feed (the BusOne rehost is non-commercial only);
  Slovenia, Serbia, Montenegro, Greece, Ukraine and the Baltics have open feeds listed by the
  Mobility Database or jbb.ghsq.de that were not checked yet. Licence duties: PKP PLK asks to
  be told of the re-use and the source and date to be stated; Czechia and Croatia publish no
  licence text, so treat them like the Flix US feed until confirmed.
- **Train counts per week** are counted over one 28-day window since 2026-10-12. Before, a
  feed listing each train once per date (Poland, SNCF, CFR, Eurostar) counted a one-day
  variant as daily and calendar.txt services counted outside their dates, so frequencies
  were inflated (Warsaw to Gdansk 1,095 a week instead of 178, Berlin to Munich 502 instead
  of 210) and the expected waits too short. Trains that do not run in the window make no
  connection at all (before, 64,000 rail edges ran 0 times a week and were still routed over).
- **How a refresh fails** (`scripts/ingest/gtfs.ts`). A feed whose download fails twice is
  skipped, or its earlier files are reused when the machine has them. If the current graph
  contains that feed, nothing is written and the run fails, so one host being down never
  ships a graph without a country. A new feed that fails is left out and the run still
  fails, so the workflow reports it. The manifest is written only after the graph, lists
  exactly the feeds in it, and dates each feed by when its files were downloaded, not by the
  run (PKP PLK's terms require the source date).
- **Station names in Cyrillic** without an English translation in the feed (the Ukrainian
  stations in the Polish feed) are romanised: Ukrainian national scheme, Bulgarian for BDZ.
- **Climate normals** cover 1,496 of 2,805 cities (the monthly job fills the rest).
- **Events** exist for 20 cities, all but five in Europe and North America; Asia has Taipei
  and Hong Kong (adapter written, feed exists), Oceania Brisbane, nothing in Africa, South
  America or the Middle East. The big names without a feed (London, Amsterdam, Rome, Tokyo)
  say so honestly.
- **Nightly boards**: 60 of 146 are European; South America (5), Oceania (6) and Africa (7)
  are thin, so a visitor there usually triggers a live search.
- **Current flight routes**: the network is 2014 OpenFlights. New routes (every low-cost base
  opened since) only appear when a Kiwi search finds them.
- **Hotels**: prices for one weekend per city per night; no reviews, no sentiment yet
  (LiteAPI has them; see below).
- **Visa**: a dataset from February 2026, not live rules; no e-visa links, no entry
  requirements beyond the visa line.
- **Costs**: a country-level price index, not a city one, so Bali and Jakarta cost the same.

## Sources worth adding next, ranked

Each one checked to exist on 2026-10-10; licence and cost as stated on the source's own page.

| # | Source | Fills | Licence and cost | Effort |
|---|---|---|---|---|
| 1 | **Open-Meteo Marine API** (`open-meteo.com/en/docs/marine-weather-api`): sea surface temperature worldwide, 8 km, 10-day forecast | sea temperature for every coast, not just Nordic and Baltic; the "beaches" style gets real water temperatures | free for non-commercial use with attribution (DWD and Open-Meteo), paid plans for commercial | an ingest like `weather.ts`, half a day |
| 2 | **Travelpayouts Data API `/data/routes.json` and `/v1/airline-directions`** (`travelpayouts.github.io/slate`): current airline routes with aircraft and codeshare | replaces the 2014 OpenFlights network; hub degree and Explore arcs become current | free with the partner token already held | an ingest replacing `routes.ts`, a day |
| 3 | **Transitous** (`transitous.org`): a community-run, provider-neutral routing API over open GTFS feeds, international | real ground times for combos, side trips and border hops instead of estimates; coverage follows the open feeds, so Europe and North America first, Asia where feeds exist | free to use, open data; attribution good manners | a `/api/reach` adapter, two days |
| 4 | **Transitland** (`transit.land`): a registry of GTFS feeds worldwide with stops and routes, plus a routing beta | finds the feeds for Asia, South America, Oceania (Malaysia KTM, Thailand, Amtrak are already queued in `feeds.ts`) | free with rate limits (key), paid professional tier | feed discovery, then the existing GTFS ingest |
| 5 | **OpenAgenda API** (`developers.openagenda.com`): events across France, Belgium, Switzerland and the communities that publish there | tens of French and Belgian cities' events beyond Paris, Bordeaux, Nantes, Ghent | free, needs a key from the account settings | one adapter in `lib/events/`, a day |
| 6 | **LiteAPI reviews and sentiment** (same key): hotel reviews with a sentiment summary | "five bad reviews about the same thing" on the hotel card | included with the production key; ask in writing before storing (SETUP §5) | half a day |
| 7 | **Ticketmaster Discovery** (code ready, `SETUP §10`): concerts, sport and theatre in about 30 countries | ticketed events where no city feed exists | free key, 5,000 calls a day | a key |
| 8 | **UK Bus Open Data Service** (`bus-data.dft.gov.uk`) and **Rail Delivery Group** GTFS: all of Great Britain's buses and trains | the British Isles in the ground graph (today only Irish Rail and FlixBus) | Open Government Licence; free registration | a feed entry each |
| 9 | **PredictHQ** (`predicthq.com`): 100M+ events in 19 categories worldwide with attendance predictions | events everywhere, including the regions with no city feed | commercial, custom pricing, free trial | only if events become a selling point |
| 10 | **Numbeo API** (`numbeo.com/common/api.jsp`): cost of living by city | city-level living costs instead of a country index (Bali ≠ Jakarta) | from $260 a month | not worth it yet; the World Bank index plus the model's estimate serves |

Not worth adding (from earlier research, not re-checked today): Google Places, Tripadvisor
and Yelp forbid storing or showing their content on a non-Google map; Skyscanner's and
Booking.com's partner APIs are closed to new small affiliates; Songkick's API is closed;
Eventbrite's public event search was withdrawn in 2020; Rome2Rio has no public API.
Amadeus for Developers Self-Service (flight and hotel search, a free test environment,
production billed per call) is the serious fallback if Kiwi's public search ever closes,
and the shape of `searchFlight` was kept simple with that in mind.

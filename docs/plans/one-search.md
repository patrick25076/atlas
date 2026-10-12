# One search: the app as one flow

Patrick, 2026-10-12: "look how bad it is, the whole experience, there's too many features that
should be merged in one, Skyscanner is intuitive, but this should be smarter". Chosen layout:
**one search, one list, plus an Advanced drawer** for the long trips.

## The shape

- **Three tabs**: Search, Ask, My trips. Deals, Explore, Trips and their modes (Short loops,
  Wild loops, Long stay, Group, A to B, the custom search, the Smart loop, Everywhere) stop
  being places to go; each becomes something the one search can return or a filter on it.
- **The search bar** (top of the Search tab, and the command line in the top bar fills it):
  - **From**: the traveller's place, airports listed (as today).
  - **To**: Anywhere (default), a city or town, a country, a region ("Southeast Asia").
  - **When**: exact dates (out and back, or one way), a flexible window ("20 to 30 Oct"), a
    must-include day, a month, or anytime (the next six months, cheapest dates).
  - **Nights**: a range (default 3 to 7), or "one way".
  - **Who**: 1 adult by default; a group editor lives in Advanced.
  - **Search**.
- **Advanced drawer** (one tap under the bar, closed by default):
  - **Trip shape**: Any (default), Return to one place, Two cities, A loop of 3+, Long stay.
  - **Wild loop through a region** (region chips, 5 to 90 nights).
  - **Long stay** (1 to 6 months, bases).
  - **Group**: who is coming, their airports and free dates.
  - Nights per place, avoid countries, trains between places, longest flight: the Trip style.
- **Filter chips under the bar** (instant, client side): Direct only, Under N h a leg, 1 city,
  2 cities, 3+, Trains OK, Events on, New countries (Been), Price max.
- **One results list**, ranked by price (Trip style can switch to balanced or comfort), each a
  **trip card**: price, route line with plane, train and coach icons ("Brașov ✈ Warsaw 🚆
  Gdańsk ✈ Otopeni"), dates, nights per place, travel hours, badges (direct, events on, new
  country, gem). The globe shows the same list as price tags and the selected card's route.
  The list streams as results arrive; the globe draws the search while it thinks.
- **One trip page** for any card: the legs with booking links (one per ticket), **Ways home**
  (a calendar of the days around, direct first, to any home airport), hotels for the dates,
  events on during the stay, sights and food per place, **Make it a plan** (the itinerary),
  save, share.
- **Ask** (the chat) works on the same search: "make it direct", "add Toruń", "cheaper",
  "what about November" change the search and the list; the chat explains and asks at most
  one question; its cards are the same trip cards.
- **My trips**: saved itineraries and searches.

## Which engine answers what (the user never picks one)

| The search | Engine |
| --- | --- |
| To = a place, dates exact | route finder (A to B) + paired one-ways, ways home |
| To = anywhere or a country, window | paired one-ways (lib/pairs.ts), flight graph first |
| Shape = two cities or a loop, or nights > 7 with To anywhere | flight graph trips (Dijkstra on euros), then the walk to confirm live |
| To = a region, nights >= 7 (Advanced: Wild) | wild by walk |
| Advanced: Long stay | long stay |
| Advanced: Group | group |
| When = anytime | price calendar (scan) per destination, flight graph everywhere |
| Events on | purpose events and city feeds as a filter and badge |

Results from all engines are normalised into one `TripResult` shape (legs, stops, total,
hours, source, booking links) so one card and one trip page render them all.

## What goes away

The Deals, Explore and Trips tabs, the mode rows, FinderForm as a separate panel, the route
card as a separate mode (it becomes the trip page), the Smart loop form, the Purpose list.
Their engines stay; only their front doors go. Old links (?view=trips&mode=wild, ?deal=…)
map onto the new search.

# "Been": countries already visited (optional)

Asked for on 2026-10-10: "add the countries you've been to and filter if you want completely
new countries or if you don't mind going again; a layover is okay anytime; optional".
Built the same evening (round three of the day's workflows). This note records what was built.

## Behaviour

- A **Been** pill in the top bar ("Been", then "Been 2" or "Been 2 · only new") opens a
  dark-glass editor: a search box over the country list (`public/data/countries.json`,
  flag + name; Enter adds the first hit, Backspace on an empty box removes the country added
  last), chips for the selected ones, a two-state switch **Revisits are fine** (default) /
  **Only new countries**, a one-line explanation and **Clear**.
- Nothing changes until a country is marked. With **Only new countries**, every search
  excludes those countries as a *destination or overnight stop*; a connection or layover
  through them is never excluded. With **Revisits are fine** the list is just a record: deal
  cards get a small "been" tag and the chat agent says when a suggestion is somewhere new.
- Stored in the browser only (`localStorage` key `atlas-been-v1`); never in the URL; the
  server only ever sees the `exclude` parameter of a search.

## The contract (as built)

Shared logic lives in `lib/been.ts`: `BeenPrefs`, `loadBeen`/`saveBeen`, `excludedCountries`,
`excludeParam`, `parseExclude` (server side, bad entries dropped, max 200), `countryAllowed`,
`filterByCountry`, `beenLine` (the sentence for the agent's system prompt).

| Place | What it does with `exclude` |
| --- | --- |
| `components/TopBar.tsx`, `components/BeenEditor.tsx` | the pill and the editor; state lives in `components/Globe.tsx` (`loadBeen` on mount, `saveBeen` on change) |
| `components/Globe.tsx` | boards, custom-search and purpose deals filtered with `filterByCountry` when only-new is on (the chat's own deals are **not** re-filtered, because the agent may lift the filter for one search); `exclude=` added to every fetch: finder, combos, wild, plan, purpose, longstay, group (URL and body), trips; short loops with a night in an excluded country dropped as belt and braces |
| `components/Panel.tsx`, `components/TripsPanel.tsx`, `components/HotelDeals.tsx` | the "been" tag on cards when revisits are fine; "Only new countries: N excluded; layovers still allowed." on the Deals tab and every Trips form; hotel deals in excluded countries hidden |
| `lib/finder.ts`, `/api/finder` | excluded countries (and cities resolved to them, `targetCountry`) removed from the target list **before** the 18-target cut, so a well-travelled visitor gets the next unvisited countries; landings in excluded countries dropped; a run with nothing left answers `searched 0` plus `note` |
| `lib/scan.ts`, `/api/scan` | an excluded destination (country, city or airport) answers with `note` and no search; landings filtered; a remembered fare in an excluded country ignored; an open-jaw home leg from an excluded country not priced |
| `lib/wild.ts`, `lib/wild-variants.ts`, `/api/wild`, `/api/plan` | never a stop or landing in an excluded country; hub positioning stays allowed (same-day connection only in an excluded hub); the optional stopover night in an excluded hub is skipped; a fully excluded region is a 400; `customKey(..., exclude)` appends `x` + a 6-character hash so stored trips and plans never collide with plain builds |
| `lib/longstay.ts`, `/api/longstay` | excluded countries drop out of the candidate bases and are listed under `skipped` |
| `lib/group.ts`, `/api/group` | passed to the finder; a host-city option only when its country is allowed; a fully excluded region is a 400 |
| `lib/purpose.ts`, `/api/purpose` | events in excluded countries hidden before any lookup |
| `lib/combos.ts`, `/api/combos` | neighbours in excluded countries skipped before searching; a deal whose own destination is excluded answers `searched 0` plus `note` (not memoised) |
| `lib/trips.ts`, `/api/trips` | excluded countries never host a night of a short loop |
| `app/api/chat/route.ts`, `lib/agent-tools.ts` | `context.been` validated with `cleanCodes`; `beenLine()` in the system prompt; every searching tool takes `exclude` (adds to the lasting list; `[]` lifts it once) and `allow` (lifts named countries once); with revisits fine, a "been there" said in chat is a record to mention, not an exclusion, unless the traveller asks for new countries; tool outputs carry `beenFilter` and `note` |

## Not doing

- No server-side account or sync (the app has no login).
- No automatic "been" from past searches or saved trips (it would guess).
- No country polygons on the globe for tap-to-mark (no polygon layer today); the editor is a
  list with search. A later step could colour visited countries on the globe.

# Open, key-free event feeds by city (verified 2026-10-10)

Research done by an agent on 2026-10-10: every endpoint was fetched that day. Counts are what
the sample returned. These are the sources for "what's on" (markets, exhibitions, festivals,
jazz nights, open-air cinema), not big ticketed concerts. The adapters live in
`lib/events/` and the route is `/api/events`.

## Adapter families

- **Opendatasoft Explore v2.1** (one adapter): Paris, Bordeaux, Nantes, Bologna, Ghent,
  Brisbane, Basel. Query: `/api/explore/v2.1/catalog/datasets/{id}/records?limit=100&where=...>=now()`.
- **Socrata SoQL** (one adapter): New York, Chicago, San Francisco, Calgary, Edmonton, Austin.
  `/resource/{id}.json?$limit=...&$where=...`. A free app token lifts throttling.
- **Linked Events** (one adapter): Helsinki `api.hel.fi/linkedevents/v1`, Espoo `api.espoo.fi/events/v1`.
- **One-off JSON/XML**: Madrid (JSON-LD file), Lisbon (WordPress REST), Vienna (GeoJSON, dates
  on event pages), Berlin (street fairs + Christmas markets JSON), Basque Country (Kulturklik),
  Ireland (Fáilte Ireland OData), Toronto (CKAN dump, 225 MB), Montreal (CSV), Hong Kong (LCSD
  XML), Taiwan (Ministry of Culture JSON), Seoul (needs a free key; sample key gives 5 rows).

## Verified endpoints

| City | Endpoint | Format | Licence | Upcoming |
|---|---|---|---|---|
| Paris | `https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/records?limit=100&where=date_end>=now()` | JSON | ODbL | 3,505 |
| Bordeaux | `https://opendata.bordeaux-metropole.fr/api/explore/v2.1/catalog/datasets/met_agenda/records?limit=100&where=lastdate_end>=now()` | JSON | Licence Ouverte | 2,577 |
| Nantes | `https://data.nantesmetropole.fr/api/explore/v2.1/catalog/datasets/244400404_agenda-evenements-nantes-metropole_v2/records?limit=100&where=date>=now()` | JSON | Licence Ouverte | 4,656 |
| Helsinki | `https://api.hel.fi/linkedevents/v1/event/?start=today&page_size=100&include=location,keywords` | JSON-LD | CC BY 4.0 | 15,268 |
| Espoo | `https://api.espoo.fi/events/v1/event/?start=today&page_size=100` | JSON-LD | CC BY 4.0 | 11,933 |
| Madrid | `https://datos.madrid.es/egob/catalogo/206974-0-agenda-eventos-culturales-100.json` | JSON-LD | CC BY 4.0 | 1,461 |
| Barcelona | CKAN dumps (174 MB / 211 MB), see package `agenda-cultural` | JSON | CC BY 4.0 | large |
| Basque Country | `https://api.euskadi.eus/culture/events/v1.0/events/upcoming?_elements=100&_page=1` | JSON | CC BY 4.0 | 4,717 |
| Bologna | `https://opendata.comune.bologna.it/api/explore/v2.1/catalog/datasets/eventi-bologna-agenda-cultura/records?limit=100&where=end>=now()` | JSON | CC BY 4.0 | 225 |
| Lisbon | `https://www.agendalx.pt/wp-json/agendalx/v1/events?per_page=100&page=1` | JSON | CC BY 4.0 | paginated |
| Berlin | `https://www.berlin.de/sen/web/service/maerkte-feste/strassen-volksfeste/index.php/index/all.json` and `.../weihnachtsmaerkte/index.php/index/all.json` | JSON | CC BY | 76 + 48 |
| Vienna | `https://www.wien.gv.at/veranstaltungen.json` (dates on each event page) | GeoJSON | CC BY 4.0 | 784 |
| Ghent | `https://data.stad.gent/api/explore/v2.1/catalog/datasets/toeristische-evenementen-visit-gent/records?limit=100` | JSON | free reuse | 29 |
| Ireland | `https://failteireland.azure-api.net/opendata-api/v2/events` (follow `@odata.nextLink`) | JSON | CC BY 4.0 | 4,516 |
| Basel | `https://data.bs.ch/api/explore/v2.1/catalog/datasets/100419/records?limit=100&where=datum>=now()` | JSON | CC BY 4.0 | 76 |
| New York | `https://data.cityofnewyork.us/resource/tvpp-9vvx.json?$limit=1000&$where=start_date_time>='DATE'` | JSON | NYC terms | 28,742 (permits, noisy) |
| Toronto | CKAN `festivals-events` dump (225 MB) | JSON | OGL Toronto | 406 events |
| Montreal | `https://donnees.montreal.ca/dataset/6a4cbf2c-c9b7-413a-86b1-e8f7081e2578/resource/6decf611-6f11-4f34-bb36-324d804c9bad/download/evenements.csv` | CSV | CC BY 4.0 | 3,568 |
| Calgary | `https://data.calgary.ca/resource/n625-9k5x.json?$limit=500` | JSON | OGL Calgary | 48 |
| Edmonton | `https://data.edmonton.ca/resource/64u3-c7bh.json?$limit=500&$where=begins>='DATE'` | JSON | Edmonton terms | 53 |
| Chicago | `https://data.cityofchicago.org/resource/vsdy-d8k7.json?$limit=1000&$where=start>='DATE'` (library events) | JSON | Chicago terms | 4,245 |
| San Francisco | `https://data.sfgov.org/resource/8i3s-ih2a.json?$limit=1000&$where=event_start_date>='DATE'` | JSON | PDDL | 1,185 |
| Seoul | `http://openapi.seoul.go.kr:8088/{KEY}/json/culturalEventInfo/1/1000/` (free key) | JSON | KOGL 1 | 19,586 |
| Hong Kong | `https://www.lcsd.gov.hk/datagovhk/event/events.xml` | XML | data.gov.hk | 1,208 |
| Taiwan | `https://cloud.culture.tw/frontsite/trans/SearchShowAction.do?method=doFindTypeJ&category=6` (1 music, 2 theatre, 3 dance, 6 exhibitions, 8 film) | JSON | OGDL v1 | hundreds per category |
| Brisbane | `https://data.brisbane.qld.gov.au/api/explore/v2.1/catalog/datasets/brisbane-city-council-events/records?limit=100&where=start_datetime>=now()` (+ `markets-events`) | JSON | CC BY 4.0 | 1,913 |

## Needs a free key (worth registering)

OpenAgenda (France, Switzerland, Belgium; `api.openagenda.com/v2/agendas/{uid}/events?key=`),
Edinburgh Festivals (`api.edinburghfestivalcity.com/events`), Flanders UiTdatabank
(`search.uitdatabank.be/events`, x-api-key), Singapore TIH, Eventfinda (NZ/AU), Seoul (above).

## Checked and empty or stale

Zurich, Amsterdam, Rotterdam, Copenhagen, Oslo, Munich, Hamburg, Cologne, London, Budapest,
Bucharest, Kraków, Vancouver, Washington DC, Melbourne, Sydney, Auckland, Cape Town, Santiago,
Lima, Mexico City (blocked from Europe), Bogotá (blocked), São Paulo (blocked), Rome, Florence,
Turin, Milan (challenges or 2023 one-offs), Los Angeles and Seattle (stale), Tokyo (ward-level
only), Toulouse (stale since 2025-12), Buenos Aires (2020).

## Noise filters

NYC permits (sports leagues, construction), Montreal council meetings, SF Rec & Park classes,
Brisbane fitness sessions: keep markets, festivals, exhibitions, music, film, street fairs,
talks; drop meetings, classes, leagues, permits without a public name.

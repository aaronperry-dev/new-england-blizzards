# New England Blizzard Atlas

Ten winters of **verified blizzard conditions** (ASOS / AWOS / METAR) and every **NWS Blizzard Warning**
across Connecticut, Rhode Island, Massachusetts, New Hampshire, Vermont and Maine — as a static,
GitHub-Pages-hosted site with a searchable archive, a pan/zoom map, and gridded frequency products.

* **Map** – pan/zoom basemap with
  * five **gridded products** (5 km): verified blizzard events / winter, chance of a verified blizzard in a winter,
    verified blizzard hours / winter, Blizzard Warnings / winter, chance of a Blizzard Warning in a winter —
    in blue → violet → pink → plum winter ramps. **Hover (tap on phones) for a cursor tooltip** with every product at that
    point, the nearest station and how well the stations support the value;
  * every **verified blizzard station-event** (dots sized/colored by count; click for the event list);
  * every **Blizzard Warning zone** (colored by number of warnings; click for the list).
* **Dashboard** – KPIs, events and warnings per winter, month-of-year, most frequent locations, and a table of every
  Blizzard Warning with how many stations inside the warned zones verified blizzard conditions.
* **Explorer**
  * *Verified events* – searchable/sortable table; click a row for the raw METAR/SPECI reports around the event.
  * *SQL* – full SQLite database in the browser (sql.js).
  * *Archive search (live)* – search **any** past ASOS/AWOS METAR (not just blizzards) straight from the IEM archive:
    station, dates, wind, visibility, weather code, or free-text / `/regex/` over the raw report.
* **GitHub Actions** – CI, a daily data rebuild, and Pages deployment.

## How a “verified blizzard” is decided

NWS definition: sustained wind or frequent gusts ≥ 35 mph **and** visibility ≤ ¼ mile due to falling/blowing snow for ≥ 3 hours.

* An observation qualifies when `max(wind, gust) ≥ 35 mph`, `visibility ≤ 0.25 mi`, and present weather contains
  snow / blowing snow (`SN`, `BLSN`, `SG`, with intensity and `SH` variants; `DRSN` excluded).
* Reports are binned into clock hours (a :53 METAR belongs to the following hour). An **event** is a run of ≥ 3
  consecutive hours that each contain a qualifying report. A missing hour ends the event.
* AWOS stations with no present-weather sensor can’t confirm snow: for station-winters that never reported a weather
  code, snow is inferred from `temperature ≤ 34 °F` and the event is tagged *inferred*.
* Stations with no visibility sensor are excluded. A station-winter counts toward frequencies only if ≥ 60 % of its hours have usable
  visibility + wind.
* **Quality control:** winds > 90 kt and gusts more than 45 kt above the sustained wind are ignored (spurious AWOS gusts exist).
  Alpine summit stations (elevation > 1000 m — in practice **Mount Washington, MWN**) are excluded: they sit in cloud in gale-force wind for much
  of the winter, so “blizzard conditions” are near-routine there (≈ 1,500 events in 10 winters vs. 3–6 at every other station) and would swamp the regional grids.
* Station-events within 12 h of each other are grouped into a **regional storm** (dated by the first local onset).

All thresholds are in [`pipeline/config.py`](pipeline/config.py).

## Gridded products — what they are and aren’t

* **Observed** grids: Gaussian-weighted (σ = 25 km) average of each station’s own per-winter rates, weighted by record length,
  left **blank** where no usable station lies within ≈ 45 km. They’re smoothed station statistics, not a physical analysis —
  terrain and coastline effects between stations aren’t resolved.
* **Warned** grids: point-in-polygon counts of NWS forecast-zone polygons (BZ.W) on the 5 km grid — no smoothing.
* Rates use **completed winters only** (Jul–Jun seasons), so the in-progress winter never biases a frequency. With ten winters,
  probabilities move in 10 % steps at a station; small differences between nearby places are not significant.

## Repository layout

```
pipeline/            Python data pipeline (IEM → events, warnings, grids, SQLite)
  build.py           orchestrator:  python -m pipeline.build
  detect.py          blizzard detection (METAR rules above)
  bzwarn.py          Blizzard Warning (VTEC BZ.W) parsing + zone geometry
  grids.py           5 km gridded products
  iem.py             IEM API client (retries, cache)
site/                static front end (no build step) — served by GitHub Pages
  index.html app.js app.css
  vendor/            MapLibre GL JS, sql.js (vendored: no CDN needed)
  data/              generated products + offline basemap outlines
tests/               pytest unit tests
.github/workflows/   ci.yml, build-data.yml, pages.yml
```

## Run it locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
pytest -q

python -m pipeline.build            # ~15-25 min the first time (downloads ≈ 10 winters × ~85 stations), then cached in cache/
python -m pipeline.build --stations BOS,PWM,BDL   # quick subset while developing

python -m http.server -d site 8000  # open http://localhost:8000
```

Data comes from the [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/) — please keep the worker count modest
(the default of 3 workers is polite; higher values get rate-limited).

## GitHub Actions setup

1. Push this repo to GitHub.
2. **Settings → Pages → Build and deployment → Source: “GitHub Actions.”**
3. **Actions** tab → *Build data & deploy* → **Run workflow** (first run backfills all winters; later runs only refresh the current one).

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push / PR | pytest + front-end syntax check |
| `build-data.yml` | daily 09:17 UTC + manual | rebuilds all data from IEM (cached), uploads it, deploys Pages. Manual inputs: *full_rebuild*, *commit_data* |
| `pages.yml` | push to `site/**`, called by build-data | publishes `site/` to GitHub Pages |

The repository ships with a committed data snapshot in `site/data/` so the site works immediately; the scheduled build
publishes fresher data to Pages without committing binaries to git (tick *commit_data* if you want a snapshot committed).

## Caveats

* METAR visibility is point-sampled and reported in discrete steps; sensor outages, AWOS limitations and station moves
  affect individual records. Coverage and sensor flags are in the `station_seasons` table.
* Blizzard conditions verified at an airport don’t necessarily match what a warned area experienced; the dashboard’s
  verification table is a station-based check, not an official NWS verification.
* The warning archive here is limited to zones in the six New England states.

## Credits

Observations & warnings: Iowa Environmental Mesonet / NWS. Basemap tiles © OpenStreetMap contributors © CARTO (optional; an offline
outline basemap is built in). State/county outlines: US Atlas (Census). Map: MapLibre GL JS. SQL: sql.js.

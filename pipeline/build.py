"""Build every data product the site needs.

    python -m pipeline.build                      # full 10-season rebuild (uses cache/)
    python -m pipeline.build --stations BOS,PWM   # quick subset for testing
"""
from __future__ import annotations

import argparse
import gzip
import json
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd
from shapely.geometry import Point

from . import config as C
from . import detect, grids, iem
from . import bzwarn as bzw


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


# ----------------------------------------------------------------------------- stations
EXCLUDED: list[dict] = []

def load_stations(seasons, only: set[str] | None) -> list[dict]:
    win_start = seasons[0].fetch_start.isoformat()
    win_end = seasons[-1].fetch_end.isoformat()
    seen: dict[str, dict] = {}
    for st in C.STATES:
        for s in iem.fetch_station_network(st):
            if only and s["id"] not in only:
                continue
            b, e = s["archive_begin"], s["archive_end"]
            if (b and b > win_end) or (e and e < win_start):
                continue
            seen[s["id"]] = s
    keep = [s for s in seen.values() if not exclusion_reason(s)]
    for s in seen.values():
        if exclusion_reason(s):
            log(f"excluding {s['id']} {s['name']}: {exclusion_reason(s)}")
            EXCLUDED.append({"id": s["id"], "name": s["name"], "state": s["state"], "reason": exclusion_reason(s)})
    return sorted(keep, key=lambda s: (s["state"], s["id"]))


def exclusion_reason(s: dict) -> str | None:
    """Why a station is left out of the blizzard analysis (None = analysed)."""
    if (s.get("elev_m") or 0) > C.MAX_ELEV_M:
        return f"summit station ({s['elev_m']:.0f} m): blizzard-like conditions are near-routine and not comparable"
    return None


def station_active(s: dict, season: C.Season) -> bool:
    b, e = s["archive_begin"], s["archive_end"]
    return not ((b and b > season.fetch_end.isoformat()) or (e and e < season.fetch_start.isoformat()))


# ----------------------------------------------------------------------------- observations
def process_station_season(s: dict, season: C.Season, today: date, refresh: bool):
    df = iem.get_season_obs(s["id"], season, today, refresh=refresh)
    if len(df) == 0:
        a = detect.StationSeason(s["id"], season.label, 0, 0, 0.0, False, False, False)
        return a, []
    df["station"] = s["id"]
    a = detect.assess_station_season(df, season, today)
    evs = detect.find_events(df, a.wx_capable) if a.vis_reported else []
    for e in evs:
        e["season"] = season.label
        e["season_valid"] = a.valid
    return a, evs


def run_observations(stations, seasons, today, workers, refresh_current):
    """Download + analyse every station-season. Returns (assessments, events, failed_jobs).

    A request that still fails after the client's own backoff does not abort the build: it is
    retried serially after a pause, and anything still failing is reported in meta.json.
    """
    jobs = [(s, se) for s in stations for se in seasons if se.has_started(today) and station_active(s, se)]
    log(f"observations: {len(jobs)} station-seasons for {len(stations)} stations")
    assess, events, failed = [], [], []
    done = 0

    def run(s, se):
        return process_station_season(s, se, today, refresh_current and not se.is_complete(today))

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(run, s, se): (s, se) for s, se in jobs}
        for f in as_completed(futs):
            try:
                a, evs = f.result()
                assess.append(a)
                events += evs
            except Exception as e:  # noqa: BLE001 - rate limit / outage; retried below
                failed.append(futs[f])
                log(f"  deferred {futs[f][0]['id']} {futs[f][1].label}: {e}")
            done += 1
            if done % 100 == 0:
                log(f"  {done}/{len(jobs)} station-seasons ({len(events)} events so far)")
    for attempt in range(3):
        if not failed:
            break
        log(f"retrying {len(failed)} deferred station-seasons (pass {attempt + 1}) after a pause")
        time.sleep(30 * (attempt + 1))
        still = []
        for s, se in failed:
            try:
                a, evs = run(s, se)
                assess.append(a)
                events += evs
            except Exception as e:  # noqa: BLE001
                log(f"  still failing {s['id']} {se.label}: {e}")
                still.append((s, se))
            time.sleep(1)
        failed = still
    return assess, events, [(s["id"], se.label) for s, se in failed]


# ----------------------------------------------------------------------------- raw METARs per event
def fetch_event_obs(e: dict, wx_capable_lookup) -> pd.DataFrame:
    pad = pd.Timedelta(hours=2)
    sts = (pd.Timestamp(e["start"]) - pad).strftime("%Y-%m-%dT%H:%MZ")
    ets = (pd.Timestamp(e["end"]) + pad).strftime("%Y-%m-%dT%H:%MZ")
    key = f"{e['station']}_{pd.Timestamp(e['start']):%Y%m%d%H%M}"
    path = C.CACHE_DIR / "event_obs" / f"{key}.csv.gz"
    if path.exists():
        df = pd.read_csv(path, parse_dates=["valid"], dtype={"wxcodes": "string", "metar": "string"})
    else:
        df = iem.fetch_obs_csv(e["station"], sts, ets, iem.OBS_COLS + ["metar"])
        path.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(path, "wt") as fh:
            df.to_csv(fh, index=False, date_format="%Y-%m-%dT%H:%M:%S%z")
    if len(df):
        df["valid"] = pd.to_datetime(df["valid"], utc=True)
        df["qualifies"] = detect.flag_qualifying(df, e["confirmed"]).astype(int)
    return df


def run_event_obs(events, workers):
    log(f"raw METARs for {len(events)} events")
    out: dict[int, pd.DataFrame] = {}
    todo = [e for e in events]
    for attempt in range(4):
        failed = []
        with ThreadPoolExecutor(max_workers=workers if attempt == 0 else 1) as ex:
            futs = {ex.submit(fetch_event_obs, e, None): e for e in todo}
            for f in as_completed(futs):
                try:
                    out[futs[f]["id"]] = f.result()
                except Exception as exc:  # noqa: BLE001
                    failed.append(futs[f])
                    log(f"  deferred METARs for event {futs[f]['id']}: {exc}")
        todo = failed
        if not todo:
            break
        time.sleep(30 * (attempt + 1))
    for e in todo:  # give up gracefully: the event is kept, only its raw-report detail is missing
        out[e["id"]] = pd.DataFrame(columns=["valid", "tmpf", "vsby", "sknt", "gust", "wxcodes", "metar", "qualifies"])
    return out


# ----------------------------------------------------------------------------- cross-checks
def cross_check(stations, events, warn_events, zones, assess):
    st_pt = {s["id"]: Point(s["lon"], s["lat"]) for s in stations}
    valid_by_season: dict[str, set[str]] = {}
    for a in assess:
        if a.valid and a.vis_reported:
            valid_by_season.setdefault(a.season, set()).add(a.station)
    for w in warn_events:
        geom = bzw.event_geometry(w, zones).buffer(0.01)
        ws, we = pd.Timestamp(w["start"]), pd.Timestamp(w["end"])
        inside = [sid for sid in valid_by_season.get(w["season"], set()) if geom.contains(st_pt[sid])]
        ver = set()
        for e in events:
            if e["station"] in inside and pd.Timestamp(e["start"]) <= we + pd.Timedelta(hours=3) \
                    and pd.Timestamp(e["end"]) >= ws - pd.Timedelta(hours=3):
                ver.add(e["station"])
        w["stations_in_area"], w["stations_verified"] = len(inside), len(ver)
        w["verified_station_ids"] = sorted(ver)
        w["_geom"] = geom
    for e in events:
        es, ee = pd.Timestamp(e["start"]), pd.Timestamp(e["end"])
        e["warned"], e["warning_id"] = 0, None
        for w in warn_events:
            if es <= pd.Timestamp(w["end"]) and ee >= pd.Timestamp(w["start"]) and w["_geom"].contains(st_pt[e["station"]]):
                e["warned"], e["warning_id"] = 1, w["id"]
                break


# ----------------------------------------------------------------------------- export
def write_json(name: str, obj, outdir: Path):
    p = outdir / name
    p.write_text(json.dumps(obj, separators=(",", ":"), default=str))
    log(f"  wrote {name} ({p.stat().st_size/1024:.0f} KB)")


SCHEMA = """
CREATE TABLE stations(id TEXT PRIMARY KEY, name TEXT, state TEXT, lat REAL, lon REAL, elev_m REAL, type TEXT,
  county TEXT, wfo TEXT, vis_capable INTEGER, valid_seasons INTEGER, events INTEGER,
  events_per_season REAL, season_prob REAL, hours_per_season REAL);
CREATE TABLE station_seasons(station TEXT, season TEXT, n_obs INTEGER, hours_with_data INTEGER, coverage REAL,
  vis_reported INTEGER, wx_capable INTEGER, valid INTEGER);
CREATE TABLE events(id INTEGER PRIMARY KEY, station TEXT, season TEXT, storm TEXT, start TEXT, "end" TEXT,
  hours INTEGER, n_qual_obs INTEGER, min_vis_mi REAL, peak_wind_mph REAL, max_sustained_mph REAL, min_tmpf REAL,
  confirmed INTEGER, warned INTEGER, warning_id TEXT);
CREATE TABLE event_obs(event_id INTEGER, valid TEXT, tmpf REAL, vsby REAL, sknt REAL, gust REAL, wxcodes TEXT,
  metar TEXT, qualifies INTEGER);
CREATE TABLE warnings(id TEXT PRIMARY KEY, wfo TEXT, year INTEGER, etn INTEGER, season TEXT, issued TEXT, start TEXT,
  "end" TEXT, zones TEXT, area_km2 REAL, ended_by TEXT, product_id TEXT, iem_url TEXT,
  stations_in_area INTEGER, stations_verified INTEGER);
CREATE INDEX ix_ev_station ON events(station); CREATE INDEX ix_ev_start ON events(start);
CREATE INDEX ix_obs_ev ON event_obs(event_id); CREATE INDEX ix_obs_metar ON event_obs(valid);
CREATE VIEW v_events AS SELECT e.*, s.name AS station_name, s.state, s.type, s.lat, s.lon FROM events e JOIN stations s ON s.id=e.station;
"""


def write_sqlite(path: Path, stations, assess, events, event_obs, warn_events):
    if path.exists():
        path.unlink()
    db = sqlite3.connect(path)
    db.executescript(SCHEMA)
    cnt: dict[str, int] = {}
    for e in events:
        cnt[e["station"]] = cnt.get(e["station"], 0) + 1
    db.executemany("INSERT INTO stations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
        (s["id"], s["name"], s["state"], s["lat"], s["lon"], s["elev_m"], "AWOS" if s["awos"] else "ASOS",
         s["county"], s["wfo"], int(s["vis_capable"]), len(s["valid_seasons_list"]), cnt.get(s["id"], 0),
         s.get("events_per_season"), s.get("season_prob"), s.get("hours_per_season")) for s in stations])
    db.executemany("INSERT INTO station_seasons VALUES (?,?,?,?,?,?,?,?)", [
        (a.station, a.season, a.n_obs, a.hours_with_data, a.coverage, int(a.vis_reported), int(a.wx_capable), int(a.valid))
        for a in assess])
    db.executemany("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
        (e["id"], e["station"], e["season"], e["storm"], e["start"], e["end"], e["hours"], e["n_qual_obs"],
         e["min_vis_mi"], e["peak_wind_mph"], e["max_sustained_mph"], e["min_tmpf"], int(e["confirmed"]),
         e["warned"], e["warning_id"]) for e in events])
    rows = []
    for eid, df in event_obs.items():
        for r in df.itertuples(index=False):
            def nz(v):
                return None if pd.isna(v) else v
            rows.append((eid, r.valid.strftime("%Y-%m-%dT%H:%MZ"), nz(r.tmpf), nz(r.vsby), nz(r.sknt), nz(r.gust),
                         nz(r.wxcodes), nz(r.metar), int(r.qualifies)))
    db.executemany("INSERT INTO event_obs VALUES (?,?,?,?,?,?,?,?,?)", rows)
    db.executemany("INSERT INTO warnings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
        (w["id"], w["wfo"], w["year"], w["etn"], w["season"], w["issued"], w["start"], w["end"],
         ",".join(w["ugcs"]), w["area_km2"], w["ended_by"], w["product_id"], w["iem_url"],
         w["stations_in_area"], w["stations_verified"]) for w in warn_events])
    db.commit()
    db.execute("VACUUM")
    db.close()
    log(f"  wrote {path.name} ({path.stat().st_size/1e6:.1f} MB, {len(rows)} event obs)")


# ----------------------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--today", help="override today (YYYY-MM-DD) for reproducible builds")
    ap.add_argument("--stations", help="comma list of station ids (testing)")
    ap.add_argument("--workers", type=int, default=3, help="parallel IEM downloads (keep small: IEM rate-limits)")
    ap.add_argument("--refresh-current", action="store_true", help="re-download the in-progress season")
    ap.add_argument("--out", default=str(C.SITE_DATA))
    args = ap.parse_args(argv)

    today = date.fromisoformat(args.today) if args.today else datetime.now(timezone.utc).date()
    seasons = C.seasons_in_window(today)
    climo = [s.label for s in seasons if s.is_complete(today)]
    log("seasons:", [s.label for s in seasons], "| climatology:", climo[0], "to", climo[-1])
    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)

    only = set(args.stations.split(",")) if args.stations else None
    stations = load_stations(seasons, only)
    log(f"{len(stations)} stations")
    assess, events, failed_fetches = run_observations(stations, seasons, today, args.workers, args.refresh_current)

    # station summaries
    by_station: dict[str, list] = {}
    for a in assess:
        by_station.setdefault(a.station, []).append(a)
    for s in stations:
        rows = by_station.get(s["id"], [])
        s["vis_capable"] = any(a.vis_reported for a in rows)
        s["valid_seasons_list"] = sorted(a.season for a in rows if a.valid and a.vis_reported)
        s["wx_capable_seasons"] = sum(1 for a in rows if a.wx_capable)

    events.sort(key=lambda e: (e["start"], e["station"]))
    detect.cluster_storms(events)
    for i, e in enumerate(events, 1):
        e["id"] = i
    log(f"{len(events)} blizzard station-events in {len({e['storm'] for e in events})} regional storms")

    event_obs = run_event_obs(events, args.workers)

    first = seasons[0].fetch_start.replace(month=7, day=1)
    warn_events, zones = bzw.fetch_all(first, today + pd.Timedelta(days=1).to_pytimedelta())
    for w in warn_events:
        w["season"] = C.season_of(datetime.fromisoformat(w["start"].replace("Z", "+00:00"))).label
    log(f"{len(warn_events)} Blizzard Warning events, {len(zones)} zones")
    cross_check(stations, events, warn_events, zones, assess)

    prod = grids.build_products(stations, events, warn_events, zones, climo)

    log("exporting")
    ev_rows = [detect.event_to_row(e) for e in events]
    for r in ev_rows:
        r.pop("season_valid", None)
    write_json("events.json", ev_rows, outdir)
    for s in stations:
        s["events"] = sum(1 for e in events if e["station"] == s["id"])
    write_json("stations.json", [{
        "id": s["id"], "name": s["name"], "state": s["state"], "lat": s["lat"], "lon": s["lon"],
        "elev_m": s["elev_m"], "type": "AWOS" if s["awos"] else "ASOS", "county": s["county"], "wfo": s["wfo"],
        "vis_capable": s["vis_capable"], "valid_seasons": len(s["valid_seasons_list"]),
        "events": s["events"], "events_per_season": s.get("events_per_season"),
        "season_prob": s.get("season_prob"), "hours_per_season": s.get("hours_per_season"),
    } for s in stations], outdir)
    write_json("warnings.json", [{k: v for k, v in w.items() if not k.startswith("_")} for w in warn_events], outdir)
    write_json("warning_zones.geojson", bzw.zones_geojson(zones), outdir)
    write_json("grids.json", prod, outdir)
    write_json("meta.json", {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "window": {"first_season": seasons[0].label, "last_season": seasons[-1].label,
                   "climatology_seasons": climo,
                   "in_progress_season": next((s.label for s in seasons if not s.is_complete(today)), None)},
        "thresholds": {"wind_mph": 35, "wind_kt": C.WIND_KT_MIN, "vis_mi": C.VIS_MI_MAX, "min_hours": C.MIN_HOURS,
                       "inferred_tmpf_max": C.INFERRED_TMPF_MAX, "min_coverage": C.MIN_COVERAGE},
        "counts": {"stations": len(stations), "stations_usable": sum(1 for s in stations if s["valid_seasons_list"]),
                   "events": len(events), "storms": len({e["storm"] for e in events}),
                   "warnings": len(warn_events), "event_obs": sum(len(d) for d in event_obs.values()),
                   "failed_fetches": len(failed_fetches)},
        "failed_fetches": [f"{sid} {se}" for sid, se in failed_fetches],
        "excluded_stations": EXCLUDED,
        "sources": {"obs": "Iowa Environmental Mesonet ASOS/AWOS/METAR archive",
                    "warnings": "NWS VTEC archive via IEM (BZ.W)"},
    }, outdir)
    write_sqlite(outdir / "blizzard.sqlite", stations, assess, ev_rows, event_obs, warn_events)
    log("done")


if __name__ == "__main__":
    main()

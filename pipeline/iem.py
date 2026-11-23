"""Thin, polite client for the Iowa Environmental Mesonet (IEM) archive APIs."""
from __future__ import annotations

import gzip
import io
import random
import time
from datetime import date
from pathlib import Path

import pandas as pd
import requests

from . import config as C

_session = requests.Session()
_session.headers.update({"User-Agent": C.USER_AGENT, "Accept-Encoding": "gzip"})

OBS_COLS = ["tmpf", "vsby", "sknt", "gust", "wxcodes"]


def _get(url: str, params=None, timeout: int = 180, tries: int = 8) -> requests.Response:
    """GET with exponential backoff (+jitter); honours Retry-After on 429/503."""
    last: object = None
    for i in range(tries):
        try:
            r = _session.get(url, params=params, timeout=timeout)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
            if r.status_code in (429, 500, 502, 503, 504):
                wait = float(r.headers.get("Retry-After", 0)) or min(60, 2 ** i)
                time.sleep(wait + random.random())
                continue
            r.raise_for_status()
        except requests.RequestException as e:  # network hiccup
            last = repr(e)
            time.sleep(min(60, 2 ** i) + random.random())
    raise RuntimeError(f"IEM request failed after {tries} tries: {url} last={last}")


def fetch_station_network(state: str) -> list[dict]:
    r = _get(f"{C.IEM}/geojson/network/{state}_ASOS.geojson", timeout=60)
    out = []
    for f in r.json()["features"]:
        p, (lon, lat) = f["properties"], f["geometry"]["coordinates"][:2]
        attrs = p.get("attributes") or {}
        out.append({
            "id": f["id"], "name": p.get("sname") or f["id"], "state": p.get("state") or state,
            "lat": round(lat, 4), "lon": round(lon, 4), "elev_m": p.get("elevation"),
            "network": p.get("network"), "awos": str(attrs.get("IS_AWOS", "")) == "1",
            "archive_begin": p.get("archive_begin"), "archive_end": p.get("archive_end"),
            "county": p.get("county"), "wfo": p.get("wfo"),
        })
    return out


def _obs_url_params(station: str, sts: str, ets: str, data: list[str]) -> list[tuple[str, str]]:
    p = [("station", station), ("sts", sts), ("ets", ets), ("tz", "UTC"), ("format", "onlycomma"),
         ("missing", "empty"), ("trace", "T"), ("report_type", "3"), ("report_type", "4")]
    p += [("data", d) for d in data]
    return p


def fetch_obs_csv(station: str, sts: str, ets: str, data: list[str] | None = None) -> pd.DataFrame:
    """Routine (3) + special (4) METAR-type observations as a DataFrame (UTC)."""
    data = data or OBS_COLS
    r = _get(f"{C.IEM}/cgi-bin/request/asos.py", params=_obs_url_params(station, sts, ets, data))
    df = pd.read_csv(io.StringIO(r.text), na_values=["M", ""], keep_default_na=True,
                     dtype={"wxcodes": "string", "metar": "string"})
    if "valid" in df:
        df["valid"] = pd.to_datetime(df["valid"], utc=True)
    return df


def season_obs_path(station: str, season: C.Season, partial: bool = False) -> Path:
    # A download made while the winter was still in progress is a ".partial" file and is never
    # trusted as the final record once the season has ended.
    return C.CACHE_DIR / "obs" / f"{station}_{season.label}{'.partial' if partial else ''}.csv.gz"


def _read_cached(path: Path) -> pd.DataFrame:
    return pd.read_csv(path, parse_dates=["valid"], dtype={"wxcodes": "string"})


def get_season_obs(station: str, season: C.Season, today: date, refresh: bool = False) -> pd.DataFrame:
    """Cached per-station-season observations.

    * completed season  -> final cache file (immutable); a stale ".partial" file is ignored and removed
    * in-progress season -> ".partial" file, re-downloaded when ``refresh`` is true
    """
    complete = season.is_complete(today)
    path = season_obs_path(station, season, partial=not complete)
    if path.exists() and (complete or not refresh):
        return _read_cached(path)
    end = min(season.fetch_end, today + pd.Timedelta(days=1).to_pytimedelta())
    if end <= season.fetch_start:
        return pd.DataFrame(columns=["station", "valid"] + OBS_COLS)
    df = fetch_obs_csv(station, f"{season.fetch_start:%Y-%m-%d}T00:00Z", f"{end:%Y-%m-%d}T00:00Z")
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt") as fh:
        df.to_csv(fh, index=False, date_format="%Y-%m-%dT%H:%M:%S%z")
    if complete:
        season_obs_path(station, season, partial=True).unlink(missing_ok=True)
    if "valid" in df and len(df):
        df["valid"] = pd.to_datetime(df["valid"], utc=True)
    return df


def fetch_warning_zip(first: date, last: date) -> bytes:
    params = [("accept", "shapefile"), ("limitps", "yes"), ("phenomena", "BZ"), ("significance", "W"),
              ("location_group", "states"), ("simple", "yes"),
              ("sts", f"{first:%Y-%m-%d}T00:00Z"), ("ets", f"{last:%Y-%m-%d}T00:00Z")]
    params += [("states[]", s) for s in C.STATES]
    return _get(f"{C.IEM}/cgi-bin/request/gis/watchwarn.py", params=params, timeout=300).content

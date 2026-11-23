"""Gridded climatology products (0.05 deg ~ 5 km) over New England.

Two families of products:

* **Observed** - verified blizzard conditions at METAR/ASOS/AWOS stations, turned into a
  surface with a Gaussian distance-weighted average of per-station rates.  Cells farther than
  ~45 km from any station with a usable record are left empty rather than extrapolated.
* **Warned** - how often each cell sat inside an NWS Blizzard Warning (zone-based polygons), a
  direct point-in-polygon count, no smoothing.

All rates use only *completed* winter seasons so partial seasons never bias a rate.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

import numpy as np
import shapely
from shapely.geometry import shape
from shapely.ops import unary_union

from . import config as C

KM_PER_DEG = 111.195


@dataclass
class Grid:
    lon: np.ndarray   # (nx,) cell-centre longitudes
    lat: np.ndarray   # (ny,) cell-centre latitudes, north -> south
    mask: np.ndarray  # (ny, nx) bool: land in New England


def make_grid() -> Grid:
    nx = int(round((C.GRID_EAST - C.GRID_WEST) / C.GRID_STEP))
    ny = int(round((C.GRID_NORTH - C.GRID_SOUTH) / C.GRID_STEP))
    lon = C.GRID_WEST + (np.arange(nx) + 0.5) * C.GRID_STEP
    lat = C.GRID_NORTH - (np.arange(ny) + 0.5) * C.GRID_STEP
    land = json.loads((C.ASSETS / "ne_states.geojson").read_text())
    poly = unary_union([shape(f["geometry"]).buffer(0.02) for f in land["features"]])
    LON, LAT = np.meshgrid(lon, lat)
    mask = shapely.contains_xy(poly, LON, LAT)
    return Grid(lon, lat, mask)


def _dist_km(g: Grid, lat0: float, lon0: float) -> np.ndarray:
    LON, LAT = np.meshgrid(g.lon, g.lat)
    dy = (LAT - lat0) * KM_PER_DEG
    dx = (LON - lon0) * KM_PER_DEG * np.cos(np.radians((LAT + lat0) / 2))
    return np.hypot(dx, dy)


def kernel_surface(g: Grid, stations: list[dict], key: str):
    """Gaussian-weighted mean of ``station[key]``; returns (value, confidence, nearest_idx, nearest_km).

    Each station is weighted by its share of valid seasons (``q``) so short records count less.
    """
    ny, nx = len(g.lat), len(g.lon)
    num = np.zeros((ny, nx))
    den = np.zeros((ny, nx))
    conf = np.zeros((ny, nx))
    near_km = np.full((ny, nx), np.inf)
    near_i = np.full((ny, nx), -1, dtype=int)
    s2 = 2 * C.KERNEL_SIGMA_KM ** 2
    for i, s in enumerate(stations):
        d = _dist_km(g, s["lat"], s["lon"])
        closer = d < near_km
        near_km = np.where(closer, d, near_km)
        near_i = np.where(closer, i, near_i)
        if s.get(key) is None or s["q"] <= 0:
            continue
        w = np.exp(-(d ** 2) / s2) * (d <= C.KERNEL_MAX_KM)
        conf += w * s["q"]
        num += w * s["q"] * s[key]
        den += w * s["q"]
    with np.errstate(invalid="ignore", divide="ignore"):
        val = np.where(den > 0, num / den, np.nan)
    val = np.where((conf >= C.KERNEL_MIN_CONF) & g.mask, val, np.nan)
    return val, conf, near_i, near_km


def station_rates(stations: list[dict], events: list[dict], climo_seasons: list[str]) -> None:
    """Annotate stations (in place) with per-season rates over valid completed seasons."""
    n_clim = len(climo_seasons)
    by = {}
    for e in events:
        if e["season"] in climo_seasons and e.get("season_valid", True):
            by.setdefault(e["station"], []).append(e)
    for s in stations:
        valid = [x for x in climo_seasons if x in s["valid_seasons_list"]]
        nv = len(valid)
        s["n_valid_clim"] = nv
        s["q"] = min(1.0, nv / n_clim) if n_clim else 0.0
        if nv < max(3, int(0.5 * n_clim)):      # need a reasonable record to contribute
            s["q"] = 0.0
            s["events_per_season"] = s["season_prob"] = s["hours_per_season"] = None
            continue
        ev = by.get(s["id"], [])
        s["events_per_season"] = len(ev) / nv
        s["season_prob"] = len({e["season"] for e in ev}) / nv
        s["hours_per_season"] = sum(e["hours"] for e in ev) / nv


def warning_rasters(g: Grid, warn_events: list[dict], zones: dict, climo_seasons: list[str]):
    """Per-cell warning counts using zone polygons. Returns (events/season, season prob)."""
    ny, nx = len(g.lat), len(g.lon)
    LON, LAT = np.meshgrid(g.lon, g.lat)
    # which zones cover each cell
    zone_hit = {u: shapely.contains_xy(z["geom"], LON, LAT) for u, z in zones.items()}
    counts = np.zeros((ny, nx))
    season_sets: list[np.ndarray] = []
    seasons = {}
    n = len(climo_seasons)
    for ev in warn_events:
        if ev["season"] not in climo_seasons:
            continue
        hit = np.zeros((ny, nx), dtype=bool)
        for u in ev["ugcs"]:
            if u in zone_hit:
                hit |= zone_hit[u]
        counts += hit
        seasons.setdefault(ev["season"], np.zeros((ny, nx), dtype=bool))
        seasons[ev["season"]] |= hit
    prob = np.zeros((ny, nx))
    for arr in seasons.values():
        prob += arr
    if n:
        counts, prob = counts / n, prob / n
    counts = np.where(g.mask, counts, np.nan)
    prob = np.where(g.mask, prob, np.nan)
    return counts, prob


def _enc(a: np.ndarray, nd: int) -> list:
    flat = a.ravel()
    return [None if not np.isfinite(v) else round(float(v), nd) for v in flat]


def build_products(stations, obs_events, warn_events, zones, climo_seasons) -> dict:
    g = make_grid()
    station_rates(stations, obs_events, climo_seasons)
    elig = [s for s in stations if s["q"] > 0]
    out = {"bounds": [C.GRID_WEST, C.GRID_SOUTH, C.GRID_EAST, C.GRID_NORTH],
           "step": C.GRID_STEP, "nx": len(g.lon), "ny": len(g.lat),
           "climo_seasons": climo_seasons, "products": {}}
    ev_s, conf, near_i, near_km = kernel_surface(g, stations, "events_per_season")
    pr_s, *_ = kernel_surface(g, stations, "season_prob")
    hr_s, *_ = kernel_surface(g, stations, "hours_per_season")
    w_s, w_p = warning_rasters(g, warn_events, zones, climo_seasons)
    P = out["products"]
    P["obs_events"] = {"label": "Verified blizzard events", "unit": "events / winter", "ramp": "ice",
                       "kind": "observed", "data": _enc(ev_s, 3)}
    P["obs_prob"] = {"label": "Chance of a verified blizzard in a winter", "unit": "% of winters", "ramp": "aurora",
                     "kind": "observed", "data": _enc(pr_s * 100, 0)}
    P["obs_hours"] = {"label": "Hours of verified blizzard conditions", "unit": "hours / winter", "ramp": "orchid",
                      "kind": "observed", "data": _enc(hr_s, 2)}
    P["warn_events"] = {"label": "Blizzard Warnings in effect", "unit": "warnings / winter", "ramp": "orchid",
                        "kind": "warned", "data": _enc(w_s, 3)}
    P["warn_prob"] = {"label": "Chance of a Blizzard Warning in a winter", "unit": "% of winters", "ramp": "aurora",
                      "kind": "warned", "data": _enc(w_p * 100, 0)}
    out["nearest"] = {"idx": [int(v) if m else -1 for v, m in zip(near_i.ravel(), g.mask.ravel())],
                      "km": _enc(np.where(g.mask, near_km, np.nan), 0)}
    out["station_ids"] = [s["id"] for s in stations]
    out["kernel"] = {"sigma_km": C.KERNEL_SIGMA_KM, "min_conf": C.KERNEL_MIN_CONF, "max_km": C.KERNEL_MAX_KM}
    out["conf"] = _enc(np.where(g.mask, conf, np.nan), 2)
    return out

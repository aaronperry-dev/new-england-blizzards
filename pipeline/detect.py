"""Blizzard-condition detection from METAR-type observations.

NWS blizzard criteria: sustained winds or frequent gusts >= 35 mph AND visibility
<= 1/4 mile due to falling and/or blowing snow, for >= 3 hours.

Implementation (documented in the README):
  * An observation *qualifies* when max(sustained, gust) >= 35 mph, visibility <= 0.25 mi
    and snow / blowing snow is reported in the present-weather group (SN, BLSN, SG, incl.
    intensity / SH variants).  Stations whose present-weather sensor was silent all season
    (typical AWOS-1/2/3) cannot confirm snow; for those station-seasons the snow test is
    replaced by temperature <= 34 F and the event is tagged ``inferred``.
  * Observations are binned to clock hours (a :53 METAR belongs to the following hour).
    An event is a run of >= 3 consecutive clock hours that each contain a qualifying obs.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from . import config as C

_SNOW_RE = re.compile(r"^[-+]?(VC)?(SH|BL)?(SN|SG)$")


def has_snow(wx) -> bool:
    """True if a present-weather string contains falling or blowing snow (not DRSN)."""
    if wx is None or wx is pd.NA or (isinstance(wx, float) and np.isnan(wx)):
        return False
    for tok in str(wx).split():
        if tok.startswith("DR"):
            continue
        if _SNOW_RE.match(tok):
            return True
    return False


@dataclass
class StationSeason:
    station: str
    season: str
    n_obs: int
    hours_with_data: int
    coverage: float
    vis_reported: bool
    wx_capable: bool
    valid: bool


def expected_hours(season: C.Season, today) -> int:
    end = min(season.fetch_end, today)
    return max(0, (end - season.fetch_start).days * 24)


def assess_station_season(df: pd.DataFrame, season: C.Season, today) -> StationSeason:
    station = df["station"].iloc[0] if len(df) else ""
    if not len(df):
        return StationSeason(station, season.label, 0, 0, 0.0, False, False, False)
    ok = df["vsby"].notna() & (df["sknt"].notna() | df["gust"].notna())
    hb = ((df["valid"] + pd.Timedelta(minutes=7)).dt.floor("h"))
    hours = int(hb[ok].nunique())
    exp = expected_hours(season, today)
    cov = hours / exp if exp else 0.0
    wx_n = int(df["wxcodes"].notna().sum())
    return StationSeason(
        station=station, season=season.label, n_obs=len(df), hours_with_data=hours,
        coverage=round(cov, 3), vis_reported=bool(df["vsby"].notna().mean() > 0.5),
        wx_capable=wx_n >= C.WX_CAPABLE_MIN_OBS, valid=cov >= C.MIN_COVERAGE)


def qc_wind(df: pd.DataFrame) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Quality-controlled (sustained, gust, max) wind in knots; implausible values become NaN."""
    sk = df["sknt"].where(df["sknt"] <= C.WIND_KT_QC_MAX)
    g = df["gust"].where((df["gust"] <= C.WIND_KT_QC_MAX) & ((df["gust"] - sk.fillna(0)) <= C.GUST_SPREAD_KT_MAX))
    return sk, g, pd.concat([sk, g], axis=1).max(axis=1)


def flag_qualifying(df: pd.DataFrame, wx_capable: bool) -> pd.Series:
    _, _, wind = qc_wind(df)
    base = (wind >= C.WIND_KT_MIN) & (df["vsby"] <= C.VIS_MI_MAX)
    if wx_capable:
        return base & df["wxcodes"].map(has_snow).astype(bool)
    return base & (df["tmpf"] <= C.INFERRED_TMPF_MAX)


def find_events(df: pd.DataFrame, wx_capable: bool, min_hours: int = C.MIN_HOURS) -> list[dict]:
    """Return blizzard events (dicts) for one station-season of observations."""
    if not len(df):
        return []
    df = df.sort_values("valid").reset_index(drop=True)
    q = flag_qualifying(df, wx_capable)
    if not q.any():
        return []
    d = df[q].copy()
    d["hb"] = ((d["valid"] + pd.Timedelta(minutes=7)).dt.floor("h"))
    hours = sorted(d["hb"].unique())
    runs, cur = [], [hours[0]]
    for h in hours[1:]:
        if h - cur[-1] == pd.Timedelta(hours=1):
            cur.append(h)
        else:
            runs.append(cur)
            cur = [h]
    runs.append(cur)
    events = []
    for run in runs:
        if len(run) < min_hours:
            continue
        sub = d[(d["hb"] >= run[0]) & (d["hb"] <= run[-1])]
        sk, _, wind = qc_wind(sub)
        sust = sk.max()
        events.append({
            "station": str(df["station"].iloc[0]),
            "start": sub["valid"].min().to_pydatetime(),
            "end": sub["valid"].max().to_pydatetime(),
            "hours": len(run),
            "n_qual_obs": int(len(sub)),
            "min_vis_mi": float(sub["vsby"].min()),
            "peak_wind_mph": round(float(wind.max()) * C.MPH_PER_KT, 0),
            "max_sustained_mph": None if pd.isna(sust) else round(float(sust) * C.MPH_PER_KT, 0),
            "min_tmpf": None if sub["tmpf"].isna().all() else float(sub["tmpf"].min()),
            "confirmed": bool(wx_capable),
        })
    return events


def cluster_storms(events: list[dict], gap_hours: float = 12.0) -> None:
    """Assign a regional ``storm`` label (local date of earliest onset) to events in place."""
    ny = ZoneInfo("America/New_York")
    order = sorted(range(len(events)), key=lambda i: events[i]["start"])
    def close(members):
        if members:
            first = min(events[i]["start"] for i in members).astimezone(ny)
            label = first.strftime("%Y-%m-%d")
            for i in members:
                events[i]["storm"] = label

    members, cluster_end = [], None
    for i in order:
        e = events[i]
        if cluster_end is not None and (e["start"] - cluster_end).total_seconds() > gap_hours * 3600:
            close(members)
            members, cluster_end = [], None
        members.append(i)
        cluster_end = e["end"] if cluster_end is None else max(cluster_end, e["end"])
    close(members)


def event_to_row(e: dict) -> dict:
    r = {k: v for k, v in e.items()}
    r["start"] = e["start"].strftime("%Y-%m-%dT%H:%MZ")
    r["end"] = e["end"].strftime("%Y-%m-%dT%H:%MZ")
    return r

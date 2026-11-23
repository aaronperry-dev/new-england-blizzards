"""Central configuration for the New England Blizzard Atlas pipeline."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "cache"                # raw downloads (never committed)
SITE_DATA = ROOT / "site" / "data"        # generated products served by the site
ASSETS = Path(__file__).resolve().parent / "assets"

IEM = "https://mesonet.agron.iastate.edu"
STATES = ["CT", "RI", "MA", "NH", "VT", "ME"]
USER_AGENT = "new-england-blizzard-atlas/1.0 (+https://github.com; research/educational)"

# ----------------------------------------------------------------------------
# Blizzard definition (NWS): sustained wind or frequent gusts >= 35 mph, visibility
# <= 1/4 mile due to falling and/or blowing snow, lasting >= 3 hours.
# ----------------------------------------------------------------------------
WIND_KT_MIN = 30.4        # 35 mph expressed in knots (METAR wind is whole knots -> >= 31 kt)
VIS_MI_MAX = 0.25         # statute miles
MIN_HOURS = 3             # blizzard conditions in >= 3 consecutive clock hours
INFERRED_TMPF_MAX = 34.0  # AWOS w/o present-weather sensor: infer snow from temperature
WX_CAPABLE_MIN_OBS = 25   # a station-season that reports >= this many wx codes can confirm snow
MIN_COVERAGE = 0.60       # share of expected hourly bins with vis+wind needed for a "valid" season
MPH_PER_KT = 1.15078

# Wind QC (spurious AWOS/ASOS gusts exist, e.g. a lone 102 kt gust in an ordinary snow report):
# winds above WIND_KT_QC_MAX, and gusts more than GUST_SPREAD_KT_MAX above the sustained wind, are ignored.
WIND_KT_QC_MAX = 90
GUST_SPREAD_KT_MAX = 45

# Alpine summit stations (e.g. MWN, Mount Washington, 1,909 m) sit in cloud with gale-force wind for much of
# the winter, so "blizzard conditions" are near-routine there and not comparable to low-elevation stations.
# They are excluded from detection, storm clustering and grids (listed in meta.json).
MAX_ELEV_M = 1000

# Warm-season months are skipped when downloading obs (Oct 1 - May 31 fetched).
SEASON_START_MD = (10, 1)
SEASON_END_MD = (6, 1)    # exclusive

# Number of completed winter seasons (Jul-Jun) kept in the rolling window.
N_COMPLETE_SEASONS = 10

# ----------------------------------------------------------------------------
# Grid
# ----------------------------------------------------------------------------
GRID_WEST, GRID_EAST = -73.8, -66.8
GRID_SOUTH, GRID_NORTH = 40.9, 47.6
GRID_STEP = 0.05
KERNEL_SIGMA_KM = 25.0
KERNEL_MIN_CONF = 0.20    # effective-station weight needed to show a smoothed value
KERNEL_MAX_KM = 90.0


@dataclass(frozen=True)
class Season:
    start_year: int

    @property
    def label(self) -> str:
        return f"{self.start_year}-{str(self.start_year + 1)[-2:]}"

    @property
    def fetch_start(self) -> date:
        return date(self.start_year, *SEASON_START_MD)

    @property
    def fetch_end(self) -> date:
        return date(self.start_year + 1, *SEASON_END_MD)

    def is_complete(self, today: date) -> bool:
        return today >= self.fetch_end

    def has_started(self, today: date) -> bool:
        return today >= self.fetch_start


def season_of(dt: datetime) -> Season:
    """Winter season (Jul-Jun) containing a UTC datetime."""
    y = dt.year if dt.month >= 7 else dt.year - 1
    return Season(y)


def seasons_in_window(today: date | None = None) -> list[Season]:
    """Last N completed seasons plus the in-progress season (if it has started)."""
    today = today or datetime.now(timezone.utc).date()
    first_open = today.year if today.month >= 7 else today.year - 1
    # latest season that is complete
    latest_complete = first_open if Season(first_open).is_complete(today) else first_open - 1
    out = [Season(y) for y in range(latest_complete - N_COMPLETE_SEASONS + 1, latest_complete + 1)]
    cur = Season(latest_complete + 1)
    if cur.has_started(today):
        out.append(cur)
    return out

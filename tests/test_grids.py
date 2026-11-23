import numpy as np
from shapely.geometry import box

from pipeline import config as C
from pipeline import grids


def test_grid_shape_and_mask():
    g = grids.make_grid()
    assert g.mask.shape == (len(g.lat), len(g.lon))
    assert g.lat[0] > g.lat[-1]                      # north -> south
    # Boston is land, mid-Atlantic is not
    i = np.argmin(abs(g.lon - -71.06)); j = np.argmin(abs(g.lat - 42.36))
    assert g.mask[j, i]
    i2 = np.argmin(abs(g.lon - -68.0)); j2 = np.argmin(abs(g.lat - 41.2))
    assert not g.mask[j2, i2]


def test_kernel_surface_constant_field_and_support_mask():
    g = grids.make_grid()
    sts = [{"lat": 42.36, "lon": -71.01, "q": 1.0, "rate": 0.4}, {"lat": 43.65, "lon": -70.31, "q": 1.0, "rate": 0.4}]
    val, conf, near_i, near_km = grids.kernel_surface(g, sts, "rate")
    ok = np.isfinite(val)
    assert ok.any() and np.allclose(val[ok], 0.4)
    # far-away northern Maine cell has no station support -> blank
    i = np.argmin(abs(g.lon - -68.5)); j = np.argmin(abs(g.lat - 46.8))
    assert np.isnan(val[j, i])
    # nearest station is reported everywhere
    assert near_km.min() < 6


def test_station_weighting_prefers_longer_records():
    g = grids.make_grid()
    sts = [{"lat": 43.0, "lon": -71.5, "q": 1.0, "rate": 1.0}, {"lat": 43.0, "lon": -71.4, "q": 0.1, "rate": 0.0}]
    val, *_ = grids.kernel_surface(g, sts, "rate")
    i = np.argmin(abs(g.lon - -71.45)); j = np.argmin(abs(g.lat - 43.0))
    assert val[j, i] > 0.8


def test_warning_raster_counts_each_event_once_per_cell():
    g = grids.make_grid()
    zones = {"MAZ001": {"geom": box(-72.5, 42.0, -71.0, 43.0)}, "MAZ002": {"geom": box(-72.0, 42.0, -70.5, 43.0)}}
    seasons = ["2016-17", "2017-18", "2018-19", "2019-20", "2020-21"]
    warns = [{"season": "2016-17", "ugcs": ["MAZ001", "MAZ002"]},   # overlapping zones, one event -> counts once
             {"season": "2016-17", "ugcs": ["MAZ001"]},
             {"season": "2018-19", "ugcs": ["MAZ002"]}]
    ev, prob = grids.warning_rasters(g, warns, zones, seasons)
    i = np.argmin(abs(g.lon - -71.5)); j = np.argmin(abs(g.lat - 42.5))   # inside both zones
    assert ev[j, i] == 3 / 5            # three events cover it
    assert prob[j, i] == 2 / 5          # in 2 of 5 seasons
    i2 = np.argmin(abs(g.lon - -72.4)); assert ev[j, i2] == 2 / 5


def test_station_rates_use_completed_valid_seasons_only():
    climo = [f"{y}-{str(y+1)[-2:]}" for y in range(2016, 2026)]
    st = [{"id": "AAA", "lat": 43, "lon": -71, "valid_seasons_list": climo + ["2026-27"]},
          {"id": "BBB", "lat": 44, "lon": -70, "valid_seasons_list": climo[:2]}]
    evs = [{"station": "AAA", "season": "2017-18", "hours": 5}, {"station": "AAA", "season": "2017-18", "hours": 3},
           {"station": "AAA", "season": "2026-27", "hours": 9}]   # in-progress season is ignored
    grids.station_rates(st, evs, climo)
    assert st[0]["events_per_season"] == 2 / 10 and st[0]["season_prob"] == 1 / 10 and st[0]["hours_per_season"] == 0.8
    assert st[1]["q"] == 0.0          # too short a record to contribute

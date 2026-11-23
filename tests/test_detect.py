from datetime import date, datetime, timezone

import pandas as pd

from pipeline import config as C
from pipeline import detect


def obs(rows, station="BOS"):
    """rows: (iso, vsby, sknt, gust, wx, tmpf)"""
    df = pd.DataFrame(rows, columns=["valid", "vsby", "sknt", "gust", "wxcodes", "tmpf"])
    df["valid"] = pd.to_datetime(df["valid"], utc=True)
    df["wxcodes"] = df["wxcodes"].astype("string")
    df["station"] = station
    return df


def hourly(n, start="2024-01-10T12:53", vis=0.25, wind=35, gust=None, wx="+SN BLSN", tmpf=20.0):
    ts = pd.date_range(start, periods=n, freq="1h", tz="UTC")
    return [(t.isoformat(), vis, wind, gust, wx, tmpf) for t in ts]


def test_has_snow_variants():
    assert detect.has_snow("+SN BLSN")
    assert detect.has_snow("-SHSN")
    assert detect.has_snow("SG")
    assert detect.has_snow("BR -SN")
    assert not detect.has_snow("DRSN")
    assert not detect.has_snow("-RA BR")
    assert not detect.has_snow("FZRA")
    assert not detect.has_snow(None)
    assert not detect.has_snow(pd.NA)


def test_three_hours_is_an_event_two_is_not():
    assert len(detect.find_events(obs(hourly(3)), wx_capable=True)) == 1
    assert detect.find_events(obs(hourly(2)), wx_capable=True) == []


def test_event_metrics():
    ev = detect.find_events(obs(hourly(5, vis=0.125, wind=30, gust=40)), wx_capable=True)[0]
    assert ev["hours"] == 5
    assert ev["min_vis_mi"] == 0.125
    assert ev["peak_wind_mph"] == round(40 * C.MPH_PER_KT)
    assert ev["confirmed"] is True


def test_wind_threshold_is_35_mph():
    # 30 kt = 34.5 mph -> not a blizzard; 31 kt = 35.7 mph -> blizzard
    assert detect.find_events(obs(hourly(4, wind=30)), wx_capable=True) == []
    assert len(detect.find_events(obs(hourly(4, wind=31)), wx_capable=True)) == 1
    # a gust alone can satisfy the wind criterion
    assert len(detect.find_events(obs(hourly(4, wind=15, gust=33)), wx_capable=True)) == 1


def test_visibility_threshold():
    assert detect.find_events(obs(hourly(4, vis=0.5)), wx_capable=True) == []


def test_rain_is_not_a_blizzard():
    assert detect.find_events(obs(hourly(4, wx="+RA", tmpf=40)), wx_capable=True) == []


def test_missing_hour_splits_events():
    rows = hourly(3) + hourly(3, start="2024-01-10T16:53")  # hour 15:53 missing
    evs = detect.find_events(obs(rows), wx_capable=True)
    # 3 hours + one missing hour + 3 hours -> two separate events
    assert len(evs) == 2 and all(e["hours"] == 3 for e in evs)


def test_special_obs_in_same_hour_do_not_inflate_duration():
    rows = hourly(3)
    rows.append(("2024-01-10T13:20:00+00:00", 0.125, 40, None, "+SN", 20.0))  # SPECI inside hour 2
    ev = detect.find_events(obs(rows), wx_capable=True)[0]
    assert ev["hours"] == 3


def test_awos_without_weather_uses_temperature_and_is_inferred():
    rows = hourly(4, wx=None, tmpf=22.0)
    ev = detect.find_events(obs(rows), wx_capable=False)
    assert len(ev) == 1 and ev[0]["confirmed"] is False
    warm = hourly(4, wx=None, tmpf=45.0)
    assert detect.find_events(obs(warm), wx_capable=False) == []


def test_cluster_storms_groups_nearby_stations():
    def ev(st, start, end):
        return {"station": st, "start": datetime.fromisoformat(start), "end": datetime.fromisoformat(end)}
    evs = [ev("BOS", "2018-01-04T15:00:00+00:00", "2018-01-04T22:00:00+00:00"),
           ev("PWM", "2018-01-04T17:00:00+00:00", "2018-01-05T01:00:00+00:00"),
           ev("BOS", "2019-02-01T10:00:00+00:00", "2019-02-01T14:00:00+00:00")]
    detect.cluster_storms(evs)
    assert evs[0]["storm"] == evs[1]["storm"] == "2018-01-04"
    assert evs[2]["storm"] == "2019-02-01"


def test_station_season_assessment_flags_missing_visibility():
    season = C.Season(2023)
    rows = [(t.isoformat(), None, 5, None, None, 30.0) for t in pd.date_range("2023-12-01", periods=500, freq="1h", tz="UTC")]
    a = detect.assess_station_season(obs(rows), season, date(2024, 7, 1))
    assert a.vis_reported is False and a.valid is False


def test_seasons_window():
    s = C.seasons_in_window(date(2026, 11, 20))
    assert [x.label for x in s][0] == "2016-17" and s[-1].label == "2026-27" and len(s) == 11
    s2 = C.seasons_in_window(date(2026, 6, 15))
    assert s2[-1].label == "2025-26" and len(s2) == 10
    assert C.season_of(datetime(2018, 1, 4, tzinfo=timezone.utc)).label == "2017-18"


def test_spurious_gust_does_not_make_a_blizzard():
    # ordinary light snow with one bogus 102 kt gust and otherwise sub-threshold wind
    rows = hourly(4, wind=9, gust=None)
    rows[1] = (rows[1][0], 0.25, 15, 102, "-SN", 21.0)
    assert detect.find_events(obs(rows), wx_capable=True) == []
    sk, g, w = detect.qc_wind(obs(rows))
    assert w.iloc[1] == 15            # the 102 kt gust was discarded, sustained wind kept


def test_plausible_gust_still_counts():
    assert len(detect.find_events(obs(hourly(4, wind=22, gust=45)), wx_capable=True)) == 1

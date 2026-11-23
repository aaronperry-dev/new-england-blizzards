from pipeline import bzwarn


def test_timestamp_format():
    assert bzwarn._fmt12("201703140400") == "2017-03-14T04:00Z"
    assert bzwarn._fmt12("2017-03-14 04:00") == "2017-03-14T04:00Z"
    assert bzwarn._fmt12("") == ""


def test_summit_station_is_excluded():
    from pipeline import build
    assert build.exclusion_reason({"id": "MWN", "name": "Mt Washington", "elev_m": 1909.0})
    assert build.exclusion_reason({"id": "BOS", "name": "Boston", "elev_m": 6.0}) is None
    assert build.exclusion_reason({"id": "XXX", "name": "no elevation", "elev_m": None}) is None


def test_in_progress_season_cache_is_never_final(tmp_path, monkeypatch):
    from datetime import date
    import pandas as pd
    from pipeline import config as C, iem
    monkeypatch.setattr(C, "CACHE_DIR", tmp_path)
    season = C.Season(2026)
    calls = []
    monkeypatch.setattr(iem, "fetch_obs_csv", lambda *a, **k: calls.append(a) or pd.DataFrame(
        {"station": ["BOS"], "valid": pd.to_datetime(["2026-11-20T12:00Z"]), "tmpf": [30.0], "vsby": [1.0], "sknt": [5.0], "gust": [None], "wxcodes": [None]}))
    iem.get_season_obs("BOS", season, date(2026, 11, 20))                 # in progress -> partial file
    assert (tmp_path / "obs" / "BOS_2026-27.partial.csv.gz").exists() and len(calls) == 1
    iem.get_season_obs("BOS", season, date(2026, 11, 21))                 # cached partial reused (no refresh)
    assert len(calls) == 1
    iem.get_season_obs("BOS", season, date(2027, 6, 5))                   # season now complete -> must re-download
    assert len(calls) == 2 and (tmp_path / "obs" / "BOS_2026-27.csv.gz").exists()
    assert not (tmp_path / "obs" / "BOS_2026-27.partial.csv.gz").exists()

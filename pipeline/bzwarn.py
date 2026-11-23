"""NWS Blizzard Warning (VTEC BZ.W) archive -> events + zone geometry."""
from __future__ import annotations

import csv
import io
import zipfile
from collections import defaultdict
from datetime import date

import shapefile  # pyshp
from shapely.geometry import shape, mapping
from shapely.ops import unary_union

from . import config as C
from . import iem


def _iso(s: str) -> str | None:
    s = (s or "").strip()
    if not s or s.lower() == "none":
        return None
    s = s.replace(" ", "T")
    return s if s.endswith("Z") else s + "Z"


def parse_zip(blob: bytes):
    """Return (events, zones) from IEM's watchwarn shapefile zip."""
    zf = zipfile.ZipFile(io.BytesIO(blob))
    names = zf.namelist()
    base = next(n[:-4] for n in names if n.endswith(".shp"))
    sf = shapefile.Reader(shp=io.BytesIO(zf.read(base + ".shp")),
                          shx=io.BytesIO(zf.read(base + ".shx")),
                          dbf=io.BytesIO(zf.read(base + ".dbf")))
    fields = [f[0] for f in sf.fields[1:]]
    zones: dict[str, dict] = {}
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for sr in sf.iterShapeRecords():
        rec = dict(zip(fields, sr.record))
        if rec.get("PHENOM") != "BZ" or rec.get("SIG") != "W":
            continue
        ugc = rec["NWS_UGC"]
        if ugc not in zones:
            zones[ugc] = {"ugc": ugc, "wfo": rec["WFO"], "geom": shape(sr.shape.__geo_interface__)}
        groups[(rec["WFO"], str(rec["VTEC_YR"]), int(rec["ETN"]))].append(rec)
    events = []
    for (wfo, year, etn), rows in groups.items():
        issued = min(_fmt12(r["INIT_ISS"]) for r in rows)
        start = min(_fmt12(r["ISSUED"]) for r in rows)
        end = max(_fmt12(r["EXPIRED"]) for r in rows)
        events.append({
            "id": f"{year}-{wfo}-{etn:04d}", "wfo": wfo, "year": int(year), "etn": etn,
            "issued": issued, "start": start, "end": end,
            "ugcs": sorted({r["NWS_UGC"] for r in rows}),
            "area_km2": round(sum(float(r["AREA_KM2"]) for r in rows), 0),
            "ended_by": "cancelled" if any(r["STATUS"] == "CAN" for r in rows) else "expired",
            "product_id": rows[0].get("PROD_ID"),
            "iem_url": f"{C.IEM}/vtec/#{year}-O-NEW-K{wfo}-BZ-W-{etn:04d}",
        })
    events.sort(key=lambda e: e["start"])
    return events, zones


def _fmt12(s: str) -> str:
    """'201703140400' -> '2017-03-14T04:00Z' (IEM shapefile timestamps)."""
    s = str(s).strip()
    if len(s) == 12 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}T{s[8:10]}:{s[10:12]}Z"
    return _iso(s) or ""


def fetch_all(first: date, last: date):
    events, zones = parse_zip(iem.fetch_warning_zip(first, last))
    return events, zones


def zones_geojson(zones: dict[str, dict]) -> dict:
    feats = []
    for ugc, z in sorted(zones.items()):
        g = z["geom"].simplify(0.002, preserve_topology=True)
        feats.append({"type": "Feature", "properties": {"ugc": ugc, "wfo": z["wfo"]},
                      "geometry": _round(mapping(g))})
    return {"type": "FeatureCollection", "features": feats}


def _round(geom: dict, nd: int = 4) -> dict:
    def r(c):
        return [round(c[0], nd), round(c[1], nd)] if isinstance(c[0], (int, float)) else [r(x) for x in c]
    return {"type": geom["type"], "coordinates": r(geom["coordinates"])}


def event_geometry(ev: dict, zones: dict):
    return unary_union([zones[u]["geom"] for u in ev["ugcs"] if u in zones])

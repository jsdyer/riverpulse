#!/usr/bin/env python3
"""Collect public ECCC data. Publish a receipt only after the entire capture validates."""
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlencode, urlsplit, parse_qsl, urlunsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
import argparse
import hashlib
import json
import math
import os
import re
import time

ROOT = Path(__file__).resolve().parents[1]
STATION = re.compile(r"[0-9]{2}[A-Z]{2}[A-Z0-9]{3}")
BASE = "https://api.weather.gc.ca"
COLLECTIONS = {"stations": "hydrometric-stations", "realtime": "hydrometric-realtime", "daily": "hydrometric-daily-mean"}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def validate_config(config):
    ids = config.get("stationIds", [])
    if not isinstance(ids, list) or not ids or len(ids) > config.get("maxStations", 20) or len(set(ids)) != len(ids) or any(not isinstance(i, str) or not STATION.fullmatch(i) for i in ids):
        raise ValueError("stationIds must contain unique ECCC station IDs (maximum maxStations)")
    if not 1 <= config.get("maxStations", 0) <= 100 or not 1 <= config.get("realtimeDays", 0) <= 30:
        raise ValueError("Use 1–100 maximum stations and 1–30 realtimeDays")
    years = config.get("historicalYears", [])
    if not isinstance(years, list) or not 1 <= len(years) <= 4 or len(set(years)) != len(years) or any(type(y) is not int or y < 1850 or y > datetime.now().year for y in years):
        raise ValueError("historicalYears must contain 1–4 different years from 1850 through this year")
    if config.get("defaultStation") not in ids:
        raise ValueError("defaultStation must be in stationIds")
    if not 100 <= config.get("pageSize", 0) <= 10000 or not 1 <= config.get("maxPages", 0) <= 100:
        raise ValueError("Invalid pagination limits")
    if config.get("sources") != {"base": BASE, **COLLECTIONS}:
        raise ValueError("This adapter supports the documented ECCC collections only")
    if not 0 <= config.get("requestGapSeconds", -1) <= 30 or not 1 <= config.get("catalogueRefreshDays", 0) <= 90 or not 1 <= config.get("historicalRefreshDays", 0) <= 365:
        raise ValueError("Invalid request spacing or catalogue refresh period")
    return config


def fetch_json(url):
    request = Request(url, headers={"Accept": "application/geo+json, application/json", "User-Agent": "CoolCode-RiverPulse/1.0 (https://coolcode.ca/riverpulse/)"})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=90) as response:
                return json.load(response)
        except (HTTPError, URLError, TimeoutError) as exc:
            if attempt == 2 or (isinstance(exc, HTTPError) and exc.code not in (429, 500, 502, 503, 504)):
                raise
            time.sleep(2 ** (attempt + 1))


def next_url(url, collection):
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.netloc != "api.weather.gc.ca" or parts.path != f"/collections/{collection}/items":
        raise ValueError("Unexpected pagination destination")
    query = dict(parse_qsl(parts.query))
    query["f"] = "json"
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ""))


def collect(collection, params, config, fetch=fetch_json):
    url = f"{BASE}/collections/{collection}/items?" + urlencode({"f": "json", "limit": config["pageSize"], **params})
    first = url
    features, seen = [], set()
    stamp = None
    for page in range(config["maxPages"]):
        if url in seen:
            raise ValueError("Pagination repeated a page")
        seen.add(url)
        payload = fetch(url)
        if payload.get("type") != "FeatureCollection" or not isinstance(payload.get("features"), list):
            raise ValueError("ECCC returned an unrecognized collection")
        features.extend(payload["features"])
        stamp = payload.get("timeStamp", stamp)
        link = next((l.get("href") for l in payload.get("links", []) if l.get("rel") == "next"), None)
        if not link:
            matched = payload.get("numberMatched")
            if isinstance(matched, int) and len(features) < matched:
                raise ValueError("Incomplete ECCC response; no next-page link")
            return features, first, stamp
        url = next_url(link, collection)
        time.sleep(config["requestGapSeconds"])
    raise ValueError("Pagination limit reached; capture not saved. Increase maxPages or reduce realtimeDays.")


def station_record(feature):
    p = feature["properties"]
    station_id = p["STATION_NUMBER"]
    if not STATION.fullmatch(station_id):
        raise ValueError("Invalid station ID in source")
    return {"id": station_id, "name": p["STATION_NAME"], "province": p["PROV_TERR_STATE_LOC"], "coordinates": feature.get("geometry", {}).get("coordinates"), "status": p.get("STATUS_EN"), "realtime": p.get("REAL_TIME") == 1, "datum": p.get("VERTICAL_DATUM"), "contributor": p.get("CONTRIBUTOR_EN")}


def numeric(value):
    if value is None:
        return None
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError("Invalid measurement")
    return value


def observations(features, station_id, kind):
    result = {}
    for feature in features:
        p = feature["properties"]
        if p.get("STATION_NUMBER") != station_id:
            raise ValueError("Source returned a different station")
        at = p["DATETIME" if kind == "realtime" else "DATE"]
        datetime.fromisoformat(at.replace("Z", "+00:00"))
        item = {"at": at, "level": numeric(p.get("LEVEL")), "discharge": numeric(p.get("DISCHARGE")), "levelSymbol": p.get("LEVEL_SYMBOL_EN"), "dischargeSymbol": p.get("DISCHARGE_SYMBOL_EN")}
        if kind == "realtime":
            item["localAt"] = p.get("DATETIME_LST")
        if at in result and result[at] != item:
            raise ValueError("Conflicting source rows at one timestamp")
        result[at] = item
    return [result[k] for k in sorted(result)]


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def refresh(root=ROOT, fetch=fetch_json):
    config = validate_config(json.loads((root / "web/config.json").read_text()))
    data = root / "web/data"
    captured = now_iso()
    index_path = data / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {"schemaVersion": 1, "captures": []}
    previous = None
    if index["captures"]:
        old_file = index["captures"][0]["file"]
        if not re.fullmatch(r"captures/[A-Za-z0-9-]+\.json", old_file):
            raise ValueError("Invalid previous capture path")
        previous = json.loads((data / old_file).read_text())
    catalogue_path = data / "stations.json"
    catalogue = json.loads(catalogue_path.read_text()) if catalogue_path.exists() else None
    stale = not catalogue or datetime.fromisoformat(captured.replace("Z", "+00:00")) - datetime.fromisoformat(catalogue["capturedAt"].replace("Z", "+00:00")) > timedelta(days=config["catalogueRefreshDays"])
    if stale:
        rows, source, stamp = collect(COLLECTIONS["stations"], {"sortby": "STATION_NUMBER"}, {**config, "maxPages": max(10, config["maxPages"])}, fetch)
        catalogue = {"schemaVersion": 1, "capturedAt": captured, "source": source, "providerTimestamp": stamp, "stations": [station_record(f) for f in rows]}
    by_id = {s["id"]: s for s in catalogue["stations"]}
    start = (datetime.now(timezone.utc) - timedelta(days=config["realtimeDays"])).isoformat(timespec="seconds").replace("+00:00", "Z")
    receipt = {"schemaVersion": 1, "tool": "riverpulse", "capturedAt": captured, "provider": "Environment and Climate Change Canada · MSC GeoMet / HYDAT", "units": {"level": "m (station datum)", "discharge": "m³/s"}, "requested": {"realtimeDays": config["realtimeDays"], "historicalYears": config["historicalYears"]}, "stations": []}
    for station_id in config["stationIds"]:
        if station_id not in by_id:
            raise ValueError(f"Unknown station {station_id}; check the ECCC catalogue")
        entry = {"station": by_id[station_id], "series": []}
        periods = [("realtime", f"{start}/{captured}", "Recent unit observations")]
        periods += [("daily", f"{y}-01-01/{y}-12-31", str(y)) for y in config["historicalYears"]]
        for kind, period, label in periods:
            prior = next((s for e in (previous or {}).get("stations", []) if e["station"]["id"] == station_id for s in e["series"] if s["kind"] == kind and s["period"] == period), None)
            retrieved = prior.get("retrievedAt", previous["capturedAt"]) if prior else None
            if kind == "daily" and prior and datetime.fromisoformat(captured.replace("Z", "+00:00")) - datetime.fromisoformat(retrieved.replace("Z", "+00:00")) < timedelta(days=config["historicalRefreshDays"]):
                entry["series"].append({**prior, "retrievedAt": retrieved})
                print(f"{station_id} daily {label}: reused source capture from {retrieved}", flush=True)
                continue
            rows, source, stamp = collect(COLLECTIONS[kind], {"STATION_NUMBER": station_id, "datetime": period, "sortby": "DATETIME" if kind == "realtime" else "DATE"}, config, fetch)
            obs = observations(rows, station_id, kind)
            entry["series"].append({"kind": kind, "label": label, "period": period, "source": source, "providerTimestamp": stamp, "retrievedAt": captured, "observations": obs})
            print(f"{station_id} {kind} {label}: {len(obs)} observations", flush=True)
            time.sleep(config["requestGapSeconds"])
        if not any(s["observations"] for s in entry["series"]):
            raise ValueError(f"No observations for {station_id} in any requested period; previous capture retained")
        receipt["stations"].append(entry)
    # All network work/validation completes before replacing the current index.
    digest = hashlib.sha256((json.dumps(receipt, ensure_ascii=False, separators=(",", ":")) + "\n").encode()).hexdigest()
    file = f"captures/{captured.replace(':', '').replace('-', '')}-{digest[:8]}.json"
    atomic_json(data / file, receipt)
    index["captures"] = [c for c in index["captures"] if c["file"] != file]
    index["captures"].insert(0, {"file": file, "capturedAt": captured, "stationIds": config["stationIds"], "sha256": digest})
    atomic_json(catalogue_path, catalogue)
    atomic_json(index_path, index)
    print(f"Saved {file}; {len(index['captures'])} captures retained.")


if __name__ == "__main__":
    try:
        refresh()
    except Exception as exc:
        raise SystemExit(f"Refresh failed; previous capture remains available: {exc}")

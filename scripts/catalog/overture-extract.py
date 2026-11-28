"""Extract Overture Maps places for the service area into a flat CSV for scripts/catalog-import.mjs.

Free and local: reads the public Overture release on Amazon S3 anonymously (no account, no cost),
keeps only rows whose bounding box lies inside the service area, and writes identity fields only.

  python3 -m venv .venv-catalog && .venv-catalog/bin/pip install "pyarrow>=18"
  .venv-catalog/bin/python scripts/catalog/overture-extract.py 2026-10-21.0 work/catalog-sources/overture.csv
  .venv-catalog/bin/python scripts/catalog/overture-extract.py 2026-10-21.0 work/catalog-sources/overture-nyc.csv new-york

The optional third argument is an import area (docs/84): boston-core (default, the first import's box) or a market
slug from scripts/lib/markets.json, extracted as the rectangle round its 25-mile circle; the import keeps the circle.
Fetching a new market's data needs the owner's approval of that dataset first.

Behind a proxy, set HTTPS_PROXY (and AWS_CA_BUNDLE for a custom certificate authority).
"""
import csv
import json
import math
import os
import sys

import pyarrow.compute as pc
import pyarrow.dataset as ds
from pyarrow import fs

AREA = dict(min_lat=42.30, max_lat=42.40, min_lon=-71.20, max_lon=-70.98)  # keep in step with SERVICE_AREA


def area_box(key: str) -> dict:
    if key == "boston-core":
        return AREA
    with open(os.path.join(os.path.dirname(__file__), "..", "lib", "markets.json"), encoding="utf-8") as fh:
        m = json.load(fh).get(key)
    if not m or key.startswith("_"):
        sys.exit(f"Unknown area {key}")
    d_lat = math.degrees(m["radiusM"] / 6371008.8)
    d_lon = d_lat / math.cos(math.radians(m["lat"]))
    return dict(min_lat=m["lat"] - d_lat, max_lat=m["lat"] + d_lat, min_lon=m["lon"] - d_lon, max_lon=m["lon"] + d_lon)


def main(release: str, out: str, area: str = "boston-core") -> None:
    AREA = area_box(area)
    kwargs = {"proxy_options": os.environ["HTTPS_PROXY"]} if os.environ.get("HTTPS_PROXY") else {}
    s3 = fs.S3FileSystem(anonymous=True, region="us-west-2", **kwargs)
    base = f"overturemaps-us-west-2/release/{release}/theme=places/type=place/"
    files = [f.path for f in s3.get_file_info(fs.FileSelector(base)) if f.type == fs.FileType.File]
    data = ds.dataset(files, filesystem=s3, format="parquet")
    flt = ((pc.field("bbox", "xmin") > AREA["min_lon"]) & (pc.field("bbox", "xmax") < AREA["max_lon"])
           & (pc.field("bbox", "ymin") > AREA["min_lat"]) & (pc.field("bbox", "ymax") < AREA["max_lat"]))
    cols = ["id", "names", "basic_category", "confidence", "operating_status", "addresses", "bbox", "websites", "sources"]
    table = data.to_table(columns=cols, filter=flt).to_pylist()
    with open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "name", "category", "confidence", "operating_status", "street", "locality", "postcode", "lat", "lon", "website", "licences"])
        for r in table:
            addr = (r.get("addresses") or [{}])[0] or {}
            b = r["bbox"]
            licences = sorted({s.get("license") for s in (r.get("sources") or []) if s.get("license")})
            w.writerow([
                r["id"], (r.get("names") or {}).get("primary") or "", r.get("basic_category") or "", r.get("confidence"),
                r.get("operating_status") or "", addr.get("freeform") or "", addr.get("locality") or "", addr.get("postcode") or "",
                (b["ymin"] + b["ymax"]) / 2, (b["xmin"] + b["xmax"]) / 2, ((r.get("websites") or [None])[0]) or "", " + ".join(licences),
            ])
    print(f"Wrote {out}: {len(table)} places in the service area (all categories; the import keeps restaurants and cafés).")


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    main(*sys.argv[1:])

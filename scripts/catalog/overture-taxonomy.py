"""Extract Overture's own place taxonomy (primary category, hierarchy, alternates) for the service area.

Used for cuisine classification (docs/49 "Cuisine"). Same public release, same licence and the same anonymous,
free S3 read as overture-extract.py; only the eating and drinking places it keeps are written.

  .venv-catalog/bin/python scripts/catalog/overture-taxonomy.py 2026-10-21.0 work/catalog-sources/overture-taxonomy-2026-10-21.0.csv

Output columns: id, primary, hierarchy (">"-joined), alternates ("|"-joined).
"""
import csv
import os
import sys

import pyarrow.compute as pc
import pyarrow.dataset as ds
from pyarrow import fs

AREA = dict(min_lat=42.30, max_lat=42.40, min_lon=-71.20, max_lon=-70.98)  # keep in step with overture-extract.py
# The basic categories the identity import keeps (docs/31 §5); everything else is never a listing.
KEEP = {"restaurant", "casual_eatery", "fast_food_restaurant", "cafe", "coffee_shop", "juice_bar", "smoothie_juice_bar",
        "food_truck", "food_court", "bakery", "dessert_shop", "ice_cream_shop", "eat_and_drink"}


def main(release: str, out: str) -> None:
    kwargs = {"proxy_options": os.environ["HTTPS_PROXY"]} if os.environ.get("HTTPS_PROXY") else {}
    s3 = fs.S3FileSystem(anonymous=True, region="us-west-2", **kwargs)
    base = f"overturemaps-us-west-2/release/{release}/theme=places/type=place/"
    files = [f.path for f in s3.get_file_info(fs.FileSelector(base)) if f.type == fs.FileType.File]
    data = ds.dataset(files, filesystem=s3, format="parquet")
    flt = ((pc.field("bbox", "xmin") > AREA["min_lon"]) & (pc.field("bbox", "xmax") < AREA["max_lon"])
           & (pc.field("bbox", "ymin") > AREA["min_lat"]) & (pc.field("bbox", "ymax") < AREA["max_lat"]))
    table = data.to_table(columns=["id", "basic_category", "taxonomy"], filter=flt)
    n = 0
    with open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "primary", "hierarchy", "alternates"])
        for r in table.to_pylist():
            t = r.get("taxonomy") or {}
            if (r.get("basic_category") or "") not in KEEP and "eat_and_drink" not in (t.get("hierarchy") or []):
                continue
            w.writerow([r["id"], t.get("primary") or "", ">".join(t.get("hierarchy") or []), "|".join(t.get("alternates") or [])])
            n += 1
    print(f"Wrote {out}: {n} eating and drinking places with Overture's taxonomy.")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: overture-taxonomy.py <release> <out.csv>")
    main(sys.argv[1], sys.argv[2])

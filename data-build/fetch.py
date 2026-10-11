"""Download the HDX Global P-code List when it has changed.

HDX blocks some HTTP clients, so every request sends a browser-like
User-Agent. Metadata comes from the CKAN API; the CSVs are only downloaded
when a resource's last_modified differs from the previous build's index.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from common import (
    CACHE_DIR,
    DATASET_ID,
    DEFAULT_OUT,
    LENGTHS_RESOURCE,
    PCODES_RESOURCE,
)

CKAN_URL = f"https://data.humdata.org/api/3/action/package_show?id={DATASET_ID}"
USER_AGENT = (
    "Mozilla/5.0 (compatible; pcode-checker-data-build/0.1; "
    "+https://github.com/renrmt/pcode-checker)"
)
RESOURCES = (PCODES_RESOURCE, LENGTHS_RESOURCE)


@dataclass
class FetchResult:
    changed: bool
    source: dict
    paths: dict[str, Path]


def http_get(url: str, retries: int = 3) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read()
        except OSError:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** (attempt + 1))
    raise AssertionError("unreachable")


def get_source_metadata() -> dict:
    """Read dataset and resource metadata from the CKAN API."""
    package = json.loads(http_get(CKAN_URL))["result"]
    return source_from_package(package)


def source_from_package(package: dict) -> dict:
    resources = {}
    for resource in package["resources"]:
        if resource["name"] in RESOURCES:
            resources[resource["name"]] = {
                "url": resource["url"],
                "lastModified": resource.get("last_modified"),
                "md5": resource.get("hash") or None,
                "size": resource.get("size"),
            }
    missing = set(RESOURCES) - set(resources)
    if missing:
        raise RuntimeError(f"HDX dataset is missing resources: {sorted(missing)}")
    return {
        "dataset": package["name"],
        "title": package.get("title"),
        "license": package.get("license_title"),
        "lastModified": package.get("last_modified"),
        "resources": resources,
    }


def is_changed(source: dict, previous_index: dict | None) -> bool:
    if not previous_index:
        return True
    previous = previous_index.get("source", {}).get("resources", {})
    return any(
        previous.get(name, {}).get("lastModified") != info["lastModified"]
        for name, info in source["resources"].items()
    )


def download(source: dict, cache_dir: Path) -> dict[str, Path]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, info in source["resources"].items():
        path = cache_dir / name
        if path.exists() and info["md5"] and md5(path.read_bytes()) == info["md5"]:
            paths[name] = path
            continue
        data = http_get(info["url"])
        if info["md5"] and md5(data) != info["md5"]:
            raise RuntimeError(
                f"{name}: checksum mismatch (expected {info['md5']}, got {md5(data)})"
            )
        path.write_bytes(data)
        paths[name] = path
    return paths


def md5(data: bytes) -> str:
    return hashlib.md5(data, usedforsecurity=False).hexdigest()


def fetch(
    previous_index: dict | None, cache_dir: Path = CACHE_DIR, force: bool = False
) -> FetchResult:
    source = get_source_metadata()
    changed = force or is_changed(source, previous_index)
    paths = download(source, cache_dir) if changed else {}
    return FetchResult(changed=changed, source=source, paths=paths)


def read_index(out_dir: Path) -> dict | None:
    path = out_dir / "index.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="data dir with the previous index.json")
    parser.add_argument("--force", action="store_true", help="download even if unchanged")
    args = parser.parse_args(argv)
    result = fetch(read_index(args.out), force=args.force)
    if result.changed:
        for name, path in result.paths.items():
            print(f"downloaded {name} -> {path}")
    else:
        print("HDX data unchanged since the last build")
    return 0


if __name__ == "__main__":
    sys.exit(main())

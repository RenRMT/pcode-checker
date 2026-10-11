"""Run fixture cases through hdx-python-country's AdminLevel (the reference oracle)."""

from __future__ import annotations

from functools import lru_cache

from hdx.location.adminlevel import AdminLevel


def payload_rows(payload: dict) -> list[dict]:
    return [
        {
            "Location": payload["iso3"],
            "Admin Level": str(level),
            "P-Code": pcode,
            "Name": name,
            "Parent P-Code": parent,
        }
        for pcode, name, parent, level in payload["units"]
    ]


def length_rows(payload: dict) -> list[dict]:
    lengths = payload.get("lengths") or []
    if not lengths:
        return []
    row = {"Location": payload["iso3"], "Country Length": lengths[0]}
    for level in range(1, 6):
        row[f"Admin {level} Length"] = lengths[level] if level < len(lengths) else ""
    return [row]


class Oracle:
    def __init__(self, payloads: dict[str, dict]):
        self.payloads = payloads

    @lru_cache(maxsize=None)
    def admin_level(self, iso3: str, level: int) -> AdminLevel:
        payload = self.payloads[iso3]
        admin = AdminLevel(admin_level=level)
        admin.setup_from_iterable(payload_rows(payload))
        admin.load_pcode_formats_from_iterable(length_rows(payload))
        return admin

    def match(self, case: dict) -> str | None:
        admin = self.admin_level(case["iso3"], case["level"])
        kwargs = {"parent": case["parent"]} if case.get("parent") else {}
        pcode, _ = admin.get_pcode(case["iso3"], case["input"], **kwargs)
        return pcode

#!/usr/bin/env python3
"""Validate deploy/k8s against the upstream Kubernetes JSON schemas.

There is no cluster in CI and no kubectl on the development host, so these
manifests would otherwise be the one part of the repository that nothing
checks -- YAML that parses is not YAML the API server would accept, and a
misspelled field in a PodSpec is silently ignored rather than rejected. The
strict schemas reject unknown properties, which is the property that matters:
`terminationGracePeriodSecond` would be dropped without complaint by a lenient
check and caught here.

Schemas are data, fetched once into a gitignored cache and read with
jsonschema. Nothing downloaded is executed.

    python3 scripts/validate-k8s.py [--k8s-version v1.31.0]
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import urllib.request

import yaml
import jsonschema

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFESTS = ROOT / "deploy" / "k8s"
CACHE = ROOT / ".devstack" / "k8s-schemas"
BASE = "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master"


def schema_name(api_version: str, kind: str) -> str:
    """`apps/v1` + `Deployment` -> `deployment-apps-v1.json`."""
    if "/" in api_version:
        group, version = api_version.split("/", 1)
        group = group.split(".")[0]
        return f"{kind.lower()}-{group}-{version}.json"
    return f"{kind.lower()}-{api_version}.json"


def load_schema(name: str, k8s_version: str) -> dict:
    cached = CACHE / k8s_version / name
    if not cached.exists():
        cached.parent.mkdir(parents=True, exist_ok=True)
        url = f"{BASE}/{k8s_version}-standalone-strict/{name}"
        with urllib.request.urlopen(url, timeout=120) as response:
            if response.status != 200:
                raise SystemExit(f"{name}: HTTP {response.status} from {url}")
            cached.write_bytes(response.read())
    return json.loads(cached.read_text())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--k8s-version", default="v1.31.0")
    args = parser.parse_args()

    files = sorted(MANIFESTS.glob("*.yaml"))
    if not files:
        raise SystemExit(f"no manifests under {MANIFESTS}")

    failures = 0
    checked = 0
    for path in files:
        for doc in yaml.safe_load_all(path.read_text()):
            if not doc:
                continue
            checked += 1
            rel = path.relative_to(ROOT)
            ident = f"{doc.get('kind')}/{doc.get('metadata', {}).get('name')}"
            try:
                schema = load_schema(schema_name(doc["apiVersion"], doc["kind"]), args.k8s_version)
            except Exception as exc:  # noqa: BLE001 -- reported, not swallowed
                print(f"  FAIL {rel} [{ident}] could not load schema: {exc}")
                failures += 1
                continue
            errors = sorted(jsonschema.Draft7Validator(schema).iter_errors(doc),
                            key=lambda e: list(e.path))
            if errors:
                failures += 1
                print(f"  FAIL {rel} [{ident}]")
                for err in errors[:8]:
                    where = "/".join(str(p) for p in err.path) or "(root)"
                    print(f"         {where}: {err.message}")
            else:
                print(f"  ok   {rel} [{ident}]")

    print(f"\n{checked} object(s) checked against Kubernetes {args.k8s_version} "
          f"strict schemas, {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

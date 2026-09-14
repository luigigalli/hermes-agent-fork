#!/usr/bin/env python3
"""Cron manifest verifier — no_agent weekly cron job (Sundays 09:00).

Compares the active service crons ($HERMES_HOME/cron/jobs.json) against the
canonical manifest ($HERMES_HOME/docs/cron-manifest.md) and prints a diff.
One-line heartbeat ("OK ...") when everything matches; full missing /
mismatched / extra report when it doesn't. Exit 0 always — the cron streak
stays clean and the delivered stdout IS the signal.

Restored 2026-09-14 per kanban t_7cecc443. Canonical spec: docs/cron-manifest.md.
"""
import json
import os
import sys
from pathlib import Path

HOME = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
MANIFEST = HOME / "docs" / "cron-manifest.md"
JOBS_JSON = HOME / "cron" / "jobs.json"


def parse_manifest(path: Path):
    """Parse the markdown table fenced by the verify markers into a list of dicts."""
    inside = False
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if "cron-manifest-verify: begin" in line:
            inside = True
            continue
        if "cron-manifest-verify: end" in line:
            break
        if not inside or not line.strip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        # skip header / separator rows
        if not cells or cells[0].lower() == "name":
            continue
        if all(set(c) <= set("-: ") for c in cells):
            continue
        if len(cells) < 5:
            continue
        rows.append({
            "name": cells[0],
            "schedule": cells[1],
            "script": cells[2],
            "mode": cells[3],
            "deliver": cells[4],
        })
    return rows


def _canonical_schedule(job: dict) -> str:
    sched = job.get("schedule") or {}
    kind = sched.get("kind")
    if kind == "interval":
        if "minutes" in sched:
            return f"{sched['minutes']}m"
        if "hours" in sched:
            return f"{sched['hours']}h"
    if kind == "cron":
        return sched.get("expr", "")
    return job.get("schedule_display", "")


def load_active(path: Path):
    data = json.loads(path.read_text(encoding="utf-8"))
    out = {}
    for j in data.get("jobs", []):
        name = j.get("name", "")
        no_agent = bool(j.get("no_agent"))
        monitor = j.get("monitor_script") or ""
        mode = "monitor" if (monitor and not no_agent) else ("no-agent" if no_agent else "agent")
        script = monitor if mode == "monitor" else (j.get("script") or "")
        out[name] = {
            "name": name,
            "schedule": _canonical_schedule(j),
            "script": script,
            "mode": mode,
            "deliver": j.get("deliver") or "",
            "enabled": j.get("enabled", True),
        }
    return out


def main() -> int:
    if not MANIFEST.exists():
        print(f"CRON MANIFEST VERIFY: manifest not found at {MANIFEST}")
        return 0
    if not JOBS_JSON.exists():
        print(f"CRON MANIFEST VERIFY: active jobs store not found at {JOBS_JSON}")
        return 0

    expected = parse_manifest(MANIFEST)
    active = load_active(JOBS_JSON)

    missing, mismatched = [], []
    for e in expected:
        a = active.get(e["name"])
        if not a:
            missing.append(e["name"])
            continue
        diffs = []
        if e["schedule"] and e["schedule"] != a["schedule"]:
            diffs.append(f"schedule: manifest={e['schedule']} active={a['schedule']}")
        if e["script"] and e["script"] != a["script"]:
            diffs.append(f"script: manifest={e['script']} active={a['script']}")
        if e["mode"] and e["mode"] != a["mode"]:
            diffs.append(f"mode: manifest={e['mode']} active={a['mode']}")
        if diffs:
            mismatched.append((e["name"], diffs))

    expected_names = {e["name"] for e in expected}
    extra = [a["name"] for a in active.values() if a["name"] not in expected_names]

    if not missing and not mismatched and not extra:
        print(f"CRON MANIFEST VERIFY: OK — all {len(expected)} service crons present and matched.")
        return 0

    print("CRON MANIFEST VERIFY: differences detected")
    if missing:
        print(f"  MISSING ({len(missing)}): in manifest but not active — a service cron was likely wiped by an update:")
        for m in missing:
            print(f"    - {m}")
    if mismatched:
        print(f"  MISMATCHED ({len(mismatched)}):")
        for name, diffs in mismatched:
            print(f"    - {name}")
            for d in diffs:
                print(f"        {d}")
    if extra:
        print(f"  EXTRA ({len(extra)}): active but not in manifest (informational):")
        for x in extra:
            print(f"    - {x}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
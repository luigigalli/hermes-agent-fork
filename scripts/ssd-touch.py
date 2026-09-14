#!/usr/bin/env python3
"""SSD keepalive touch — no_agent cron job (every 5m).

Touches a marker file on the external SSD mount so the disk's idle-sleep
timer never elapses. Silent on success (empty stdout = no delivery); all
diagnostics go to stderr so the cron streak stays clean. Best-effort: a
missing mount is not a failure (there is simply nothing to keep alive).

Restored 2026-09-14 per kanban t_7cecc443. Canonical spec: docs/cron-manifest.md.
"""
import os
import sys
from pathlib import Path

MOUNT = "/Volumes/AI System Luigi"
MARKER = Path(MOUNT) / ".hermes-keepalive"


def main() -> int:
    if not os.path.ismount(MOUNT):
        print(f"SSD keepalive: mount not present ({MOUNT}); skipping", file=sys.stderr)
        return 0
    try:
        MARKER.parent.mkdir(parents=True, exist_ok=True)
        if not MARKER.exists():
            MARKER.touch()
        # refresh mtime -> the "touch" that defeats idle sleep
        os.utime(MARKER, None)
    except Exception as exc:  # best-effort; never fail the cron streak
        print(f"SSD keepalive error: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
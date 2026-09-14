#!/usr/bin/env bash
# GitOps Update Check — cron --monitor-script (daily 09:00).
#
# Monitor mode: this runs each tick BEFORE the agent. Its stdout MUST be
# byte-stable across ticks (no timestamps): identical output suppresses the
# agent run; a change injects a MONITOR CHANGE DETECTED diff and wakes the
# agent. Mutually exclusive with --no-agent.
#
# Reports the Convergence repo's `convergence` branch vs its upstream
# `fork/main`. When fork/main advances (new commits available to pull), the
# short SHA / behind-count change -> the agent wakes and delivers an
# update-available notice. When nothing moved, output is identical -> silent.
#
# Restored 2026-09-14 per kanban t_7cecc443. Canonical spec: docs/cron-manifest.md.
set -euo pipefail

cd "$HOME/.hermes"

# Best-effort fetch; a dead network must not crash the monitor.
git fetch fork main --quiet 2>/dev/null || true

up_sha=$(git rev-parse --short fork/main 2>/dev/null || echo "unknown")
behind=$(git rev-list --count HEAD..fork/main 2>/dev/null || echo "0")

# Stable one-liner. Changes only when fork/main moves or the behind-count shifts.
echo "fork/main=${up_sha} behind=${behind}"
# Cron Service Manifest (Convergence)

Canonical source of truth for the **service crons** that must survive Hermes
updates. The cron job store (`cron/jobs.json`) is NOT version-controlled and
is wiped when an update recreates `~/.hermes`; this file IS version-controlled
in the `convergence` branch, so it persists. A weekly verifier
(`Cron manifest verify (weekly)`) compares the active crons against this
manifest and delivers the diff — see `scripts/cron-manifest-verify.py`.

> Rooted lesson (kanban t_7cecc443, 2026-09-14): service crons are lost not
> just via `rm` but via a Hermes update that recreates `~/.hermes` and zeroes
> `cron/jobs.json`. The manifest + verifier pair makes a future wipe
> detectable and the crons restorable from this spec.

## How to restore after a wipe

For each entry below, run against the **default** profile (the profile the
gateway/scheduler runs — `hermes serve` with no `-p`):

```bash
HERMES_HOME="$HOME/.hermes" HERMES_PROFILE= hermes cron create "<schedule>" \
  --name "<name>" [--script <script> --no-agent | --monitor-script <script>] \
  --deliver <deliver> ["<prompt>"]
```

Scripts live in `~/.hermes/scripts/` and are version-controlled alongside this
file; restore them with `git checkout` if they too were wiped.

## Active service crons

<!-- cron-manifest-verify: begin -->
| name | schedule | script | mode | deliver |
|------|----------|--------|------|---------|
| Visor data refresh (5m) | 5m | visor-refresh.py | no-agent | local |
| SSD keepalive touch (5m) | 5m | ssd-touch.py | no-agent | local |
| GitOps Update Check | 0 9 * * * | gitops-update-monitor.sh | monitor | all |
| Cron manifest verify (weekly) | 0 9 * * 0 | cron-manifest-verify.py | no-agent | all |
<!-- cron-manifest-verify: end -->

### Notes

- **Schedule column** is the canonical form the verifier compares against:
  `Nm` for interval jobs, a 5-field cron expression otherwise.
- **SSD keepalive touch** touches `/Volumes/AI System Luigi/.hermes-keepalive`
  every 5 min to defeat the external SSD's idle-sleep timer. Silent on success.
- **GitOps Update Check** is monitor-gated: `gitops-update-monitor.sh` fetches
  `fork/main` each tick and emits a byte-stable state line; the agent runs only
  when that line changes (new commits available to pull) and delivers a notice.
  It reports only — it never pulls or merges.
- **Cron manifest verify (weekly)** runs Sundays 09:00, delivers to all
  connected platforms. OK = silent-ish one-line heartbeat; differences =
  full missing/mismatched/extra report.

## Out of scope (tracked separately, not verified here)

These pre-update snapshot crons (2026-09-11) are user reminders/governance,
not infrastructure service crons, and are restored on demand — add them here
only if you want the verifier to gate them:

- Rule Proposal Watchdog (kanban urgenti) — `rule-proposal-watchdog.py`, 60m, telegram
- Promemoria Comitato Regole — `committee-reminder.py`, daily, telegram
- Promemoria meeting Finance Organization — `finance-meeting-reminder.py`, daily 09:00, telegram (was paused)
- Repo sync-check weekly (fleet census) — `repo-sync-check.py`, monday 09:00, all
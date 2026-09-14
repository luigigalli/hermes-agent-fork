#!/usr/bin/env bash
# verify-db-regen-cron.sh — no_agent weekly cron job (Mondays 08:00).
#
# Wrapper around standards/scripts/verify-db-regeneration.sh that adapts its
# exit-code convention for gateway delivery:
#   verifier exit 0 = DB rigenerabile         → one-line OK heartbeat (quiet)
#   verifier exit 1 = divergenze live-vs-rebuild → full report (last ~20 lines)
#   verifier exit 2 = errore (seed rotto, DB assente) → full report (last ~20 lines)
#
# The wrapper always exits 0 so the cron streak stays clean; the delivered
# stdout IS the signal (same convention as cron-manifest-verify.py).
#
# Created 2026-09-14 per kanban t_4ecb6fc2. Canonical spec: docs/cron-manifest.md.
set -uo pipefail

VERIFIER="$HOME/.hermes/standards/scripts/verify-db-regeneration.sh"
STANDARDS_REPO="$HOME/.hermes/standards"

if [ ! -f "$VERIFIER" ]; then
  echo "VERIFY-DB-REGEN: ERRORE — verifier script non trovato: $VERIFIER"
  echo "  (standards repo non clonato? restore richiesto)"
  exit 0
fi

# Run the verifier, capture combined stdout+stderr, preserve exit code.
output_file="$(mktemp)"
trap 'rm -f "$output_file"' EXIT

bash "$VERIFIER" --repo "$STANDARDS_REPO" > "$output_file" 2>&1
rc=$?

case "$rc" in
  0)
    # Quiet heartbeat: extract the ESITO summary line from the verifier output.
    esito=$(grep '^ESITO:' "$output_file" | tail -1)
    if [ -z "$esito" ]; then
      esito="OK — DB TEN_STANDARDS rigenerabile (verifier exit 0)."
    fi
    echo "VERIFY-DB-REGEN: OK — $esito"
    ;;
  1)
    echo "VERIFY-DB-REGEN: DIVERGENZE — live DB != rebuild (verifier exit 1). Ultime ~20 righe:"
    echo "---"
    tail -20 "$output_file"
    echo "---"
    echo "Azione: ispezionare conteggi divergenti e righe solo-live/solo-rebuild nel report sopra."
    ;;
  2)
    echo "VERIFY-DB-REGEN: ERRORE — verifier exit 2 (seed rotto, DB live assente/corrotto). Ultime ~20 righe:"
    echo "---"
    tail -20 "$output_file"
    echo "---"
    echo "Azione: controllare i seed del repo standards ($STANDARDS_REPO) e il DB live."
    ;;
  *)
    echo "VERIFY-DB-REGEN: EXIT CODE INATTESO ($rc). Ultime ~20 righe:"
    echo "---"
    tail -20 "$output_file"
    echo "---"
    ;;
esac

exit 0

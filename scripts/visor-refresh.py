#!/usr/bin/env python3
# Regenerates the standards visor data + standalone file (cron wrapper).
import subprocess
r = subprocess.run(['python3', '/Users/luigimacmini/.hermes/visor/gen_data.py'],
                   capture_output=True, text=True)
print(r.stdout.strip() or r.stderr.strip())

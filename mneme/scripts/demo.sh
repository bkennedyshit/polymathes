#!/usr/bin/env bash
# Mneme 60-second demo — seeds a tiny creator workspace and runs a search.
# Works with zero heavy deps (uses the deterministic hash backend). For real
# semantic results, install the [clip] extra and drop `MNEME_BACKEND=hash`.
set -euo pipefail

WORK="$(mktemp -d)"
export MNEME_DB_PATH="$WORK/mneme.db"
export MNEME_BACKEND="${MNEME_BACKEND:-hash}"

echo "Seeding a sample creator workspace at: $WORK"
mkdir -p "$WORK/content/skating/reels" \
         "$WORK/content/skating/photos" \
         "$WORK/input/skating/raw"

printf 'fake-frame-bytes' > "$WORK/content/skating/reels/backflip.png"
printf 'fake-photo-bytes' > "$WORK/content/skating/photos/rider_sunset.png"
printf 'raw clip notes: handrail session, golden hour' \
  > "$WORK/input/skating/raw/session_notes.md"

echo
echo "== mneme index =="
mneme index "$WORK"

echo
echo "== mneme info =="
mneme info

echo
echo "== mneme search 'handrail golden hour' =="
mneme search "handrail session golden hour" --min-score 0.0 --top-k 5 || true

echo
echo "Done. (With MNEME_BACKEND=auto + the [clip] extra, the same flow does real"
echo "visual search over your actual photos and video.)"

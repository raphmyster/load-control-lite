#!/usr/bin/env bash
# M0 acceptance check: no trace of the original operator anywhere in the repo.
# The term list lives OUTSIDE the repo (it names the operator), so pass its path:
#   scripts/check-debrand.sh ../debrand-terms.txt
set -euo pipefail
terms="${1:?usage: check-debrand.sh <terms-file>}"
cd "$(dirname "$0")/.."
if grep -rniIF -f "$terms" --exclude-dir=.git .; then
  echo "FAIL: operator terms found (above)" >&2
  exit 1
fi
big=$(find . -path ./.git -prune -o -type f -size +200k -print)
if [ -n "$big" ]; then echo "FAIL: unexpectedly large files (embedded images?):" >&2; echo "$big" >&2; exit 1; fi
echo "PASS: no operator terms, no large embedded files"

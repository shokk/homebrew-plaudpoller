#!/usr/bin/env bash
# scripts/test/formula-patch.sh
#
# Local dry-run for the "Update Formula with computed version + checksums"
# step in .github/workflows/release.yml. Run this before trusting a change
# to that step to CI again:
#
#   ./scripts/test/formula-patch.sh
#
# It builds a scratch copy of Formula/plaudpoller.rb, runs the exact same
# ruby/awk pipeline the workflow runs, and asserts the result.

set -euo pipefail

cd "$(dirname "$0")/../.."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp Formula/plaudpoller.rb "$TMP/plaudpoller.rb"

export TAG="9.9.9"
SHA_ARM64="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SHA_X64="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

ruby -pi -e '$_.sub!(/version ".*"/, %(version "#{ENV["TAG"]}"))' "$TMP/plaudpoller.rb"

awk -v arm64="$SHA_ARM64" -v x64="$SHA_X64" '
  BEGIN { n = 0 }
  /sha256 "/ {
    n++
    if (n == 1) { sub(/sha256 ".*"/, "sha256 \"" arm64 "\"") }
    else if (n == 2) { sub(/sha256 ".*"/, "sha256 \"" x64 "\"") }
  }
  { print }
' "$TMP/plaudpoller.rb" > "$TMP/plaudpoller.rb.tmp"
mv "$TMP/plaudpoller.rb.tmp" "$TMP/plaudpoller.rb"

echo "--- patched formula ---"
cat "$TMP/plaudpoller.rb"
echo "-----------------------"

FAIL=0
grep -qF "version \"${TAG}\"" "$TMP/plaudpoller.rb" || { echo "FAIL: version not patched"; FAIL=1; }
grep -qF "sha256 \"${SHA_ARM64}\"" "$TMP/plaudpoller.rb" || { echo "FAIL: arm64 sha256 not patched"; FAIL=1; }
grep -qF "sha256 \"${SHA_X64}\"" "$TMP/plaudpoller.rb" || { echo "FAIL: x64 sha256 not patched"; FAIL=1; }

# Also assert ordering: arm64 sha must appear before x64 sha (arm64 block first).
ARM_LINE=$(grep -n "sha256 \"${SHA_ARM64}\"" "$TMP/plaudpoller.rb" | cut -d: -f1)
X64_LINE=$(grep -n "sha256 \"${SHA_X64}\"" "$TMP/plaudpoller.rb" | cut -d: -f1)
if [ "$ARM_LINE" -ge "$X64_LINE" ]; then
  echo "FAIL: arm64 sha256 line ($ARM_LINE) is not before x64 sha256 line ($X64_LINE)"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "formula-patch dry-run FAILED"
  exit 1
fi

echo "formula-patch dry-run PASSED"

#!/usr/bin/env bash
# Builds AI-Story-Studio-Setup-<version>.exe, a single Windows setup program that carries the app.
# Cross-compiles with Go (1.24+) on Linux, macOS or Windows (Git Bash); needs no Windows tools.
#
#   installer/windows/build-setup.sh [output-dir]
#
# The app package is taken from the COMMITTED sources (git archive), so .env, data/, node_modules,
# logs and other local files can never end up inside the .exe.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$(cd "$here/../.." && pwd)"
repo="$(git -C "$app" rev-parse --show-toplevel)"
prefix="$(git -C "$app" rev-parse --show-prefix)" # e.g. "ai-story-studio/" (empty at the repo root)
version="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$app/package.json" | head -n 1)"
[ -n "$version" ] || { echo "could not read the version from package.json" >&2; exit 1; }
out="${1:-$app}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
exe="$out/AI-Story-Studio-Setup-$version.exe"

if [ -n "$(git -C "$repo" status --porcelain -- "$app")" ]; then
  echo "note: uncommitted changes are NOT included (the package is built from HEAD)." >&2
fi

payload="$here/setup/payload/app.zip"
rm -f "$payload"
git -C "$repo" archive --format=zip -o "$payload" "HEAD:${prefix}"

cd "$here/setup"
export GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=windows GOARCH=amd64
go build -trimpath -ldflags "-s -w -X main.version=$version" -o "$exe" .
rm -f "$payload"

echo "Built $exe ($(du -h "$exe" | cut -f1))"
if command -v sha256sum >/dev/null; then sha256sum "$exe"; fi

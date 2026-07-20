#!/usr/bin/env bash
#
# Cut a release: bump the version, stamp the CHANGELOG, commit, and tag.
# Project-agnostic — works for Node projects (package.json) and anything else
# (a plain VERSION file).
#
# Usage:
#   scripts/release.sh <version>      # e.g. scripts/release.sh 0.2.0
#
# What it does:
#   1. validates <version> is semver and the working tree is clean
#   2. bumps the version source:
#        - package.json (+ lockfile) via `npm version`, if package.json exists
#        - otherwise a plain ./VERSION file (created if missing)
#   3. rewrites CHANGELOG.md: "## [Unreleased]" entries become
#      "## [<version>] - <today>", leaving a fresh empty "## [Unreleased]" on top
#   4. commits and creates an annotated tag v<version>
#
# It does NOT push — review, then: git push && git push --tags
# (Pushing the tag triggers the GitHub Actions release workflow, if present.)

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <version>   (e.g. $0 0.2.0)" >&2
  exit 2
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: '$VERSION' is not a MAJOR.MINOR.PATCH semver" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f CHANGELOG.md ]; then
  echo "error: no CHANGELOG.md in $ROOT" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is not clean — commit or stash first" >&2
  exit 1
fi
if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  echo "error: tag v$VERSION already exists" >&2
  exit 1
fi

DATE="$(date +%F)"   # YYYY-MM-DD
ADD_FILES=(CHANGELOG.md)

echo "==> Bumping version to $VERSION"
bumped=""

# 1. Ecosystem-canonical source.
if [ -f package.json ]; then
  npm version "$VERSION" --no-git-tag-version >/dev/null
  ADD_FILES+=(package.json)
  [ -f package-lock.json ] && ADD_FILES+=(package-lock.json)
  echo "    package.json -> $VERSION"
  bumped=1
elif [ -f Cargo.toml ]; then
  # Update the version in the [package] table only — never touch dependency
  # versions in [dependencies] etc.
  awk -v ver="$VERSION" '
    /^\[/ { inpkg = ($0 ~ /^\[package\]/) }
    inpkg && !done && /^[[:space:]]*version[[:space:]]*=/ {
      sub(/version[[:space:]]*=.*/, "version = \"" ver "\""); done=1
    }
    { print }
  ' Cargo.toml > Cargo.toml.tmp && mv Cargo.toml.tmp Cargo.toml
  ADD_FILES+=(Cargo.toml)
  # Keep Cargo.lock's entry for this crate in sync, if present and cargo is here.
  if [ -f Cargo.lock ] && command -v cargo >/dev/null 2>&1; then
    cargo update --workspace --offline >/dev/null 2>&1 \
      || cargo update --workspace >/dev/null 2>&1 || true
    ADD_FILES+=(Cargo.lock)
  fi
  echo "    Cargo.toml -> $VERSION"
  bumped=1
fi

# 2. Xcode apps: the version of record is MARKETING_VERSION in the project
# (that's what xcodebuild uses for the bundle / distribution). Bump every
# MARKETING_VERSION entry (typically Debug + Release).
XCODEPROJ="$(find . -maxdepth 1 -name '*.xcodeproj' -print -quit 2>/dev/null || true)"
if [ -n "$XCODEPROJ" ] && [ -f "$XCODEPROJ/project.pbxproj" ]; then
  PBX="$XCODEPROJ/project.pbxproj"
  sed -i.bak -E "s/(MARKETING_VERSION[[:space:]]*=[[:space:]]*)[^;]+;/\\1$VERSION;/g" "$PBX"
  rm -f "$PBX.bak"
  ADD_FILES+=("$PBX")
  echo "    MARKETING_VERSION -> $VERSION ($PBX)"
  bumped=1
fi

# 3. macOS/Swift apps built via the Makefile.template keep the version as
# `VERSION = x.y.z` in their Makefile (baked into Info.plist's
# CFBundleShortVersionString at build time). Sync it whenever present — this also
# keeps a Rust+app project (Cargo.toml + Makefile) consistent across both files.
# (For an Xcode app whose Makefile does bundling/distribution, have that Makefile
# read MARKETING_VERSION rather than hardcode a VERSION, so there's one source.)
if [ -f Makefile ] && grep -qE '^[[:space:]]*VERSION[[:space:]]*=' Makefile; then
  sed -i.bak -E "s/^([[:space:]]*VERSION[[:space:]]*=[[:space:]]*).*/\\1$VERSION/" Makefile
  rm -f Makefile.bak
  ADD_FILES+=(Makefile)
  echo "    Makefile VERSION -> $VERSION"
  bumped=1
fi

# 4. Fallback for projects with no recognized version source.
if [ -z "$bumped" ]; then
  echo "$VERSION" > VERSION
  ADD_FILES+=(VERSION)
  echo "    wrote ./VERSION (no package.json / Cargo.toml / Xcode / Makefile VERSION found)"
fi

echo "==> Stamping CHANGELOG.md ([Unreleased] -> [$VERSION] - $DATE)"
awk -v ver="$VERSION" -v date="$DATE" '
  !done && /^## \[Unreleased\]/ {
    print; print ""; print "## [" ver "] - " date
    done=1; next
  }
  { print }
' CHANGELOG.md > CHANGELOG.tmp && mv CHANGELOG.tmp CHANGELOG.md

echo "==> Committing and tagging"
git add "${ADD_FILES[@]}"
git commit -m "Release $VERSION" >/dev/null
git tag -a "v$VERSION" -m "Release $VERSION"

echo "==> Done. Tagged v$VERSION."
echo "    Review:  git show v$VERSION"
echo "    Publish: git push && git push --tags"

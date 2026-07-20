# Releasing

How to version and release this project. It uses
[Semantic Versioning](https://semver.org/) and a
[Keep a Changelog](https://keepachangelog.com/)-style `CHANGELOG.md`.

- The version lives in the project's natural place: **`package.json`** (Node),
  **`Cargo.toml`** (Rust), **`MARKETING_VERSION`** in the `.xcodeproj` (Xcode apps),
  a Makefile **`VERSION = …`** variable (SwiftPM/Makefile.template apps, baked into
  `Info.plist`), or a plain **`VERSION`** file otherwise. The release script bumps
  whichever it finds — and also syncs a Makefile `VERSION` when present, so a Rust
  crate or Xcode app that also uses a Makefile for bundling stays consistent.
- Changes accumulate under **`## [Unreleased]`** in `CHANGELOG.md` until you cut
  a release, at which point they get stamped with a version number and date.
- The CHANGELOG is kept current as part of normal work (see the project's
  CLAUDE.md "Versioning" rule) — releasing is just stamping what's already there.

## Versioning (semver)

`MAJOR.MINOR.PATCH`:

| Bump | When | Example |
|---|---|---|
| **PATCH** | backward-compatible bug fixes | `0.1.0` → `0.1.1` |
| **MINOR** | new, backward-compatible features | `0.1.0` → `0.2.0` |
| **MAJOR** | breaking changes | `0.1.0` → `1.0.0` |

## During development

Add bullets under `## [Unreleased]` grouped by type: `Added`, `Changed`,
`Fixed`, `Removed`, `Security`, `Deprecated`. No version number yet.

## Cutting a release

### Option 1 — the script (recommended)

```bash
scripts/release.sh 0.2.0
```

Validates the version + clean tree, then bumps the version source
(`package.json` / `Cargo.toml` / Xcode `MARKETING_VERSION` / Makefile `VERSION` /
`VERSION` file), stamps `CHANGELOG.md`
(`[Unreleased]` → `## [0.2.0] - <today>`, leaving a fresh empty `[Unreleased]`),
commits `Release 0.2.0`, and tags `v0.2.0`. It does **not** push:

```bash
git show v0.2.0
git push && git push --tags
```

### Option 2 — manually

1. Bump the version where your project keeps it: `npm version 0.2.0
   --no-git-tag-version` (Node), the `version` in `Cargo.toml` (Rust),
   `MARKETING_VERSION` in the `.xcodeproj` (Xcode apps), the `VERSION =` line in
   the `Makefile` (SwiftPM apps), or a `VERSION` file.
2. In `CHANGELOG.md`, turn `## [Unreleased]` into a fresh empty `[Unreleased]`
   above a new `## [0.2.0] - YYYY-MM-DD` holding the entries.
3. `git commit -am "Release 0.2.0" && git tag -a v0.2.0 -m "Release 0.2.0"`
   then `git push && git push --tags`.

## Automatic release on tag (GitHub Actions)

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which:

1. (Node projects) installs deps and runs `npm test`;
2. **verifies the tag matches the project version** and fails if not;
3. extracts that version's section from `CHANGELOG.md`;
4. publishes a **GitHub Release** named after the tag with those notes.

So the normal flow is:

```bash
scripts/release.sh 0.2.0     # bump + changelog + commit + tag (local)
git push && git push --tags  # the tag push -> CI builds the GitHub Release
```

Requires the repo on GitHub (uses the built-in `GITHUB_TOKEN`).

## Optional: comparison links

To make `## [0.2.0]` headings link to git diffs, add a footer to `CHANGELOG.md`
(replace `<owner>/<repo>`):

```markdown
[Unreleased]: https://github.com/<owner>/<repo>/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/<owner>/<repo>/releases/tag/v0.2.0
```

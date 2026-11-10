# security-audit.md

How cmd-center's security audit works: what `make security-audit` runs, how
to read the result, and what to do when a check fails. The audit comes from the
shared security kit (`~/repo/claude/templates/security-kit`); the script is the
same in every project, and this project's settings are in `security-audit.conf`.

## Quick start

1. Install the tools (once):

   ```bash
   brew install gitleaks semgrep
   ```

2. Log in to Semgrep (once, from **Terminal.app**; Claude Code's `!` prefix is
   not an interactive terminal and will not work):

   ```bash
   semgrep login
   ```

3. For a macOS app, build it so the bundle checks have something to inspect:

   ```bash
   make bundle
   ```

4. Run the audit:

   ```bash
   make security-audit
   ```

5. Read the summary at the bottom. **FAIL** must be 0. The full output is in
   `security-audit.log` (git ignores it).

6. Before a release, add the sanitizers (slow):

   ```bash
   make security-audit FULL=1
   ```

## Results

| Result | Meaning | Fails the audit? |
|---|---|---|
| PASS | The check ran and found nothing wrong | No |
| FAIL | A real problem. Fix it before releasing | **Yes** |
| WARN | Needs a decision: fix it, or record why it is intended | No |
| SKIP | The check could not run, or does not apply. The note says why | No |

## What the audit checks

| Step | Check | FAIL when | WARN when |
|---|---|---|---|
| 1 | Security tests (`SECURITY_TESTS` in the conf) | The tests fail | |
| 2 | Gitleaks: git history and working tree | A secret is found | |
| 3 | Semgrep project rules (`semgrep/`) | An ERROR rule matches | A WARNING rule matches |
| 3 | Semgrep platform scan (`semgrep ci`) | A finding of ERROR, HIGH or CRITICAL severity | An advisory finding (WARNING, MEDIUM, LOW, INFO); offline; a file could not be parsed |
| 4 | Dependencies: `npm audit` (Node) or osv-scanner (Swift packages) | A high or critical vulnerability | Moderate or low, or not scanned |
| 5 | GitHub Actions pinned to commit SHAs | Any `uses:` with a tag such as `@v4` | |
| 6 | Entitlements (macOS) | A key that switches off the hardened runtime | Sandbox off with no reason recorded; a temporary exception |
| 7 | Built app (macOS) | Bad signature; forbidden key in the signed entitlements; Developer ID build without the hardened runtime | ATS allows cleartext with no reason recorded; ad-hoc signature |
| 8 | DMG (macOS) | | Not notarized or not stapled |
| 9 | Sanitizers (`FULL=1` only) | A sanitizer reports an error | |

A SKIP on step 1 means the project has **no security tests yet**. That is the
most useful gap to close: add a `test-security` Makefile target that runs tests
written for how this app could be attacked, then set `SECURITY_TESTS` in
`security-audit.conf`.

### Why each check exists

- **Secrets:** a key committed once stays in git history after it is deleted.
- **Semgrep platform:** about 1,900 rules with data-flow tracking, free for up to
  10 contributors. The scan runs on this Mac; findings go to your Semgrep
  dashboard, which is why it is skipped, not failed, when you are logged out.
- **Base rules** (`semgrep/rules.yml`): mistakes found in real projects here,
  which the platform rules miss: `select()` overruns, values interpolated into
  shell quotes, `exec()` with built strings, servers listening on every
  network interface, certificate checks switched off.
- **Pinned Actions:** a tag can be moved to different code by whoever controls
  the Action, and a release workflow can publish your releases.
- **Hardened runtime keys:** each one lets other code into the app (a debugger,
  an unsigned library, `DYLD_INSERT_LIBRARIES`).
- **Sandbox and ATS:** both are often relaxed for good reasons. The audit only
  asks that the reason is written down, in `SANDBOX_OFF_REASON` or `ATS_REASON`.

## Settings (`security-audit.conf`)

| Setting | Meaning |
|---|---|
| `PROJECT_TYPE` | `swiftpm`, `xcode`, `node` or `other`; decides which steps run |
| `APP_NAME` | Shown in the log header |
| `APP_BUNDLE`, `DMG` | Where `make bundle` and `make dmg` put the app |
| `ENTITLEMENTS` | The entitlements file used for signing |
| `SECURITY_TESTS` | Command that runs the security tests; empty means SKIP |
| `SANDBOX_OFF_REASON` | Why the App Sandbox is off, and where that is explained |
| `ATS_REASON` | Why `NSAllowsArbitraryLoads` is true |
| `SANITIZE_CMDS` | Commands run with `FULL=1` |

## When a check fails

1. Open `security-audit.log` and search for the step's `==` heading.
2. Run the command shown in the FAIL line on its own to see the full detail.
3. Fix the cause. Do not weaken the check to make it pass.
4. If a finding is intended, record it where the tool expects:
   - Semgrep: `// nosemgrep: <full rule id>` directly above the line, with the
     reason on the line above that.
   - Gitleaks: an allowlist in `.gitleaks.toml`, limited to the rule and the file.
5. Run `make security-audit` again until FAIL is 0.

## Files

| File | Role |
|---|---|
| `scripts/security-audit.sh` | The audit (shared; update with `security-kit/install.sh --update-script`) |
| `security-audit.conf` | This project's settings |
| `.gitleaks.toml` | Gitleaks config: default rules, build folders ignored |
| `semgrep/` | Semgrep rules: the kit's base rules plus any project rules |
| `.semgrepignore` | Paths Semgrep skips: its defaults, build output, changelogs and plans |
| `security-audit.log` | Output of the last run (git ignored) |

#!/usr/bin/env bash
# Security audit from ~/repo/claude/templates/security-kit.
# Run with: make security-audit   (FULL=1 adds sanitizers)
#
# This script is identical in every project; per-project settings live in
# security-audit.conf next to the Makefile. What each check does and how to
# read the output: security-audit.md. Update the script in every project by
# re-running security-kit/install.sh --update-script.
#
# Exit status is 0 when nothing FAILs. WARN and SKIP do not fail the audit.

set -uo pipefail
cd "$(dirname "$0")/.."

FULL=0
[ "${1:-}" = "--full" ] && FULL=1

# Defaults, overridden by security-audit.conf ---------------------------------
PROJECT_TYPE=other            # swiftpm | xcode | ios | node | go | other
APP_NAME=$(basename "$PWD")
APP_BUNDLE=""                 # e.g. dist/App.app
DMG=""                        # e.g. dist/App.dmg
ENTITLEMENTS=""               # e.g. App.entitlements
SECURITY_TESTS=""             # command that runs the security tests, e.g. "make test-security"
DEPS_CMD=""                   # project's own dependency check, e.g. "make vuln"; overrides step 4's default
SANDBOX_OFF_REASON=""         # set when the App Sandbox is off on purpose, with where it is explained
ATS_REASON=""                 # set when NSAllowsArbitraryLoads is true on purpose
SANITIZE_CMDS=()              # commands run with FULL=1
[ -f security-audit.conf ] && . ./security-audit.conf

LOG="security-audit.log"

# Keys that switch off part of the hardened runtime.
FORBIDDEN_KEYS=(
  com.apple.security.get-task-allow
  com.apple.security.cs.disable-library-validation
  com.apple.security.cs.allow-dyld-environment-variables
  com.apple.security.cs.allow-unsigned-executable-memory
  com.apple.security.cs.allow-jit
  com.apple.security.cs.disable-executable-page-protection
  com.apple.security.cs.debugger
)

pass=0; fail=0; warn=0; skip=0
rows=()

record() {   # record STATUS "check" "detail"
  local status=$1 check=$2 detail=$3
  case $status in
    PASS) pass=$((pass + 1)) ;; FAIL) fail=$((fail + 1)) ;;
    WARN) warn=$((warn + 1)) ;; SKIP) skip=$((skip + 1)) ;;
  esac
  rows+=("$(printf '%-5s  %-34s %s' "$status" "$check" "$detail")")
  printf '  %-5s %s\n' "$status" "$check"
}

section() { printf '\n== %s\n' "$1" | tee -a "$LOG"; }

has_key() {  # has_key <plist-file> <key>
  /usr/libexec/PlistBuddy -c "Print :$2" "$1" >/dev/null 2>&1
}

key_true() {  # key_true <plist-file> <key>: present AND true. A key set to false grants nothing.
  [ "$(/usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null)" = "true" ]
}

is_macos_app() { [ "$PROJECT_TYPE" = swiftpm ] || [ "$PROJECT_TYPE" = xcode ]; }

: > "$LOG"
echo "$APP_NAME security audit, $(date '+%Y-%m-%d %H:%M')" | tee -a "$LOG"

# 1. Security tests ---------------------------------------------------------------
section "1. Security tests"
if [ -n "$SECURITY_TESTS" ]; then
  if bash -c "$SECURITY_TESTS" >>"$LOG" 2>&1; then
    record PASS "security tests" "$SECURITY_TESTS"
  else
    record FAIL "security tests" "$SECURITY_TESTS failed; see $LOG"
  fi
else
  record SKIP "security tests" "none yet: add a test-security target, then set SECURITY_TESTS"
fi

# 2. Secrets ------------------------------------------------------------------------
section "2. Secrets (Gitleaks)"
if command -v gitleaks >/dev/null; then
  cfg=(); [ -f .gitleaks.toml ] && cfg=(--config .gitleaks.toml)
  if [ -d .git ]; then
    if gitleaks git --no-banner --redact ${cfg[@]+"${cfg[@]}"} . >>"$LOG" 2>&1; then
      record PASS "no secrets in git history" ""
    else
      record FAIL "secrets in git history" "gitleaks git --redact -v ."
    fi
  fi
  # Working tree: files git ignores (.env, a local SSH host key) are where local
  # secrets belong, so findings in them are not counted. Everything else is.
  dir_json=$(mktemp)
  gitleaks dir --no-banner --redact ${cfg[@]+"${cfg[@]}"} --report-format json --report-path "$dir_json" . >>"$LOG" 2>&1
  dir_status=$?
  tracked_hits=$(python3 -I -c 'import json,subprocess,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    d=[]
n=0
for x in d:
    f=x.get("File","")
    ignored=subprocess.run(["git","check-ignore","-q",f],capture_output=True).returncode==0
    print("  %s %s:%s%s" % (x.get("RuleID",""), f, x.get("StartLine",""), " (gitignored, not counted)" if ignored else ""), file=sys.stderr)
    if not ignored: n+=1
print(n)' "$dir_json" 2>>"$LOG")
  rm -f "$dir_json"
  if [ "$dir_status" -gt 1 ]; then
    record WARN "working tree secret scan" "gitleaks failed (exit $dir_status); see $LOG"
  elif [ "${tracked_hits:-0}" = "0" ]; then
    record PASS "no secrets in working tree" "gitignored files not counted"
  else
    record FAIL "secrets in working tree" "$tracked_hits in files git would commit: gitleaks dir --redact -v ."
  fi
else
  record SKIP "gitleaks" "brew install gitleaks"
fi

# 3. Static analysis ------------------------------------------------------------------
section "3. Static analysis (Semgrep)"
if command -v semgrep >/dev/null; then
  if [ -d semgrep ]; then
    rules_json=$(mktemp)
    semgrep scan --metrics=off --quiet --json --config semgrep/ . >"$rules_json" 2>>"$LOG"
    counts=$(python3 -I -c 'import json,sys
try:
    r=json.load(open(sys.argv[1]))["results"]
    e=sum(1 for x in r if x["extra"]["severity"]=="ERROR")
    print(e, len(r)-e)
    for x in r: print("  %s:%s %s" % (x["path"], x["start"]["line"], x["check_id"]), file=sys.stderr)
except Exception:
    print("? ?")' "$rules_json" 2>>"$LOG")
    rm -f "$rules_json"
    read -r r_err r_warn <<<"$counts"
    if [ "$r_err" = "?" ]; then
      record WARN "semgrep project rules" "could not run; see $LOG"
    elif [ "$r_err" != "0" ]; then
      record FAIL "semgrep project rules" "$r_err error(s), $r_warn warning(s): semgrep scan --config semgrep/ ."
    elif [ "$r_warn" != "0" ]; then
      record WARN "semgrep project rules" "$r_warn warning(s) to review: semgrep scan --config semgrep/ ."
    else
      record PASS "semgrep project rules" "0 findings"
    fi
  fi

  # Semgrep AppSec Platform: about 1,900 paid-tier rules and data-flow tracking,
  # free for up to 10 contributors. Needs `semgrep login` from Terminal.app.
  # The scan runs here; findings go to the Semgrep dashboard, which is why it is
  # skipped rather than failed when logged out.
  if semgrep show identity >/dev/null 2>&1 || [ -n "${SEMGREP_APP_TOKEN:-}" ]; then
    ci_json=$(mktemp)
    semgrep ci --json-output="$ci_json" >>"$LOG" 2>&1
    ci_status=$?
    # ERROR, HIGH and CRITICAL fail the audit. WARNING, MEDIUM, LOW and INFO
    # are advice ("consider certificate pinning") and show as WARN. A supply
    # chain finding is also advice when Semgrep's reachability analysis shows
    # the code never calls the vulnerable function, or when the package is a
    # dev-only npm package (test browsers, linters) that never ships, matching
    # npm audit --omit=dev in step 4.
    counts=$(python3 -I -c 'import json,sys
def dev_only(x):
    dm = x["extra"].get("sca_info", {}).get("dependency_match", {})
    pkg = dm.get("found_dependency", {}).get("package")
    lock = dm.get("lockfile", "")
    if not pkg or not lock.endswith("package-lock.json"):
        return False
    try:
        entry = json.load(open(lock)).get("packages", {}).get("node_modules/" + pkg, {})
    except Exception:
        return False
    return entry.get("dev") is True
try:
    d=json.load(open(sys.argv[1])); r=d.get("results",[])
    hard=0
    for x in r:
        sev=x["extra"].get("severity","").upper()
        dev=dev_only(x)
        unreachable=x["extra"].get("sca_info",{}).get("reachable") is False
        note=" (dev-only)" if dev else (" (not reachable)" if unreachable else "")
        if sev in ("ERROR","HIGH","CRITICAL") and not note: hard+=1
        print("  %s%s %s:%s %s" % (sev, note, x["path"], x["start"]["line"], x["check_id"]), file=sys.stderr)
    print(hard, len(r)-hard, len(d.get("errors",[])))
except Exception:
    print("? ? ?")' "$ci_json" 2>>"$LOG")
    rm -f "$ci_json"
    read -r ci_hard ci_soft ci_errors <<<"$counts"
    if [ "$ci_status" -ge 2 ] || [ "$ci_hard" = "?" ]; then
      record WARN "semgrep platform scan" "did not complete (exit $ci_status); offline? see $LOG"
    elif [ "$ci_hard" != "0" ]; then
      record FAIL "semgrep platform scan" "$ci_hard error/high, $ci_soft advisory: semgrep ci, then fix or nosemgrep with a reason"
    elif [ "$ci_soft" != "0" ]; then
      record WARN "semgrep platform scan" "$ci_soft advisory finding(s) to review: semgrep ci"
    elif [ "$ci_errors" != "0" ]; then
      record WARN "semgrep platform scan" "0 findings, $ci_errors parse error(s): part of a file was not analysed"
    else
      record PASS "semgrep platform scan" "0 findings"
    fi
  else
    record SKIP "semgrep platform scan" "not logged in: run semgrep login in Terminal.app"
  fi
else
  record SKIP "semgrep" "brew install semgrep"
fi

# 4. Dependencies ------------------------------------------------------------------------
section "4. Third-party dependencies"
if [ -n "$DEPS_CMD" ]; then
  if bash -c "$DEPS_CMD" >>"$LOG" 2>&1; then
    record PASS "dependency check" "$DEPS_CMD"
  else
    record FAIL "dependency check" "$DEPS_CMD reported problems or could not run; see $LOG"
  fi
elif [ "$PROJECT_TYPE" = node ] && [ -f package.json ]; then
  if [ -f package-lock.json ]; then
    audit_json=$(mktemp)
    npm audit --omit=dev --json >"$audit_json" 2>>"$LOG"
    counts=$(python3 -I -c 'import json,sys
try:
    v=json.load(open(sys.argv[1]))["metadata"]["vulnerabilities"]
    print(v.get("critical",0)+v.get("high",0), v.get("moderate",0)+v.get("low",0))
except Exception:
    print("? ?")' "$audit_json")
    rm -f "$audit_json"
    read -r d_high d_low <<<"$counts"
    if [ "$d_high" = "?" ]; then
      record WARN "npm audit (production deps)" "did not complete; offline? run npm audit --omit=dev"
    elif [ "$d_high" != "0" ]; then
      record FAIL "npm audit (production deps)" "$d_high high/critical: npm audit --omit=dev"
    elif [ "$d_low" != "0" ]; then
      record WARN "npm audit (production deps)" "$d_low moderate/low: npm audit --omit=dev"
    else
      record PASS "npm audit (production deps)" "0 known vulnerabilities"
    fi
  else
    record WARN "npm audit" "no package-lock.json, so installs are not reproducible"
  fi
elif is_macos_app; then
  pkgs=0
  for resolved in Package.resolved *.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved; do
    [ -f "$resolved" ] || continue
    n=$(grep -c '"identity"\|"package"' "$resolved" 2>/dev/null || true)
    pkgs=$((pkgs + ${n:-0}))
  done
  if [ "$pkgs" -eq 0 ]; then
    record PASS "third-party Swift packages" "none"
  elif command -v osv-scanner >/dev/null; then
    if osv-scanner scan source -r . >>"$LOG" 2>&1; then
      record PASS "third-party Swift packages" "$pkgs package(s), no known vulnerabilities"
    else
      record FAIL "third-party Swift packages" "osv-scanner found issues; see $LOG"
    fi
  else
    record WARN "third-party Swift packages" "$pkgs package(s), not scanned: brew install osv-scanner"
  fi
else
  record SKIP "dependencies" "no package manager detected"
fi

# 5. GitHub Actions ------------------------------------------------------------------------
section "5. GitHub Actions"
if ls .github/workflows/*.y*ml >/dev/null 2>&1; then
  # A tag such as @v4 can be moved to different code by whoever controls the
  # Action. Only a full 40-character commit SHA is fixed.
  unpinned=$(grep -hE '^\s*-?\s*uses:\s*[^ ./][^@ ]*@' .github/workflows/*.y*ml \
    | grep -vE '@[0-9a-f]{40}(\s|$)' || true)
  if [ -z "$unpinned" ]; then
    record PASS "actions pinned to commit SHAs" ""
  else
    n=$(printf '%s\n' "$unpinned" | wc -l | tr -d ' ')
    printf 'Unpinned:\n%s\n' "$unpinned" >>"$LOG"
    record FAIL "actions pinned to commit SHAs" "$n unpinned: see release-kit README, Pinned GitHub Actions"
  fi
else
  record SKIP "github actions" "no workflows"
fi

# 6. Entitlements ------------------------------------------------------------------------
if is_macos_app; then
  section "6. Entitlements ($ENTITLEMENTS)"
  if [ -n "$ENTITLEMENTS" ] && [ -f "$ENTITLEMENTS" ]; then
    bad=""
    for key in "${FORBIDDEN_KEYS[@]}"; do key_true "$ENTITLEMENTS" "$key" && bad="$bad ${key#com.apple.security.}"; done
    if [ -z "$bad" ]; then
      record PASS "no hardened-runtime exceptions" ""
    else
      record FAIL "hardened-runtime exception" "$bad"
    fi
    if grep -q 'temporary-exception' "$ENTITLEMENTS"; then
      record WARN "sandbox temporary exception" "review each temporary-exception key"
    fi
    sandbox=$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.app-sandbox' "$ENTITLEMENTS" 2>/dev/null)
    if [ "$sandbox" = "true" ]; then
      record PASS "app sandbox on" ""
    elif [ -n "$SANDBOX_OFF_REASON" ]; then
      record PASS "app sandbox off, documented" "$SANDBOX_OFF_REASON"
    else
      record WARN "app sandbox off" "turn it on, or record why in SANDBOX_OFF_REASON"
    fi
  else
    record WARN "entitlements file" "none found; set ENTITLEMENTS in security-audit.conf"
  fi
fi

# 7. Built app --------------------------------------------------------------------------
if is_macos_app; then
  section "7. Built app ($APP_BUNDLE)"
  if [ -n "$APP_BUNDLE" ] && [ -d "$APP_BUNDLE" ]; then
    if codesign --verify --deep --strict "$APP_BUNDLE" >>"$LOG" 2>&1; then
      record PASS "signature valid" ""
    else
      record FAIL "signature invalid" "codesign --verify --deep --strict $APP_BUNDLE"
    fi

    embedded=$(mktemp)
    codesign -d --entitlements :- "$APP_BUNDLE" >"$embedded" 2>/dev/null
    bad=""
    if [ -s "$embedded" ]; then
      for key in "${FORBIDDEN_KEYS[@]}"; do key_true "$embedded" "$key" && bad="$bad ${key#com.apple.security.}"; done
    fi
    rm -f "$embedded"
    if [ -z "$bad" ]; then
      record PASS "signed entitlements clean" ""
    else
      record FAIL "signed entitlements" "$bad"
    fi

    ats=$(plutil -extract NSAppTransportSecurity.NSAllowsArbitraryLoads raw "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null)
    if [ "$ats" = "true" ]; then
      if [ -n "$ATS_REASON" ]; then
        record PASS "ATS relaxed, documented" "$ATS_REASON"
      else
        record WARN "ATS allows cleartext HTTP" "NSAllowsArbitraryLoads is true; remove it or record why in ATS_REASON"
      fi
    else
      record PASS "ATS enforced" ""
    fi

    sig=$(codesign -dvv "$APP_BUNDLE" 2>&1)
    if echo "$sig" | grep -q "Authority=Developer ID Application"; then
      if echo "$sig" | grep -Eq "flags=0x[0-9a-f]*\(.*runtime"; then
        record PASS "hardened runtime on" "Developer ID build"
      else
        record FAIL "hardened runtime off" "Developer ID build without --options runtime"
      fi
    else
      record WARN "ad-hoc signature" "hardened runtime is applied by make sign; rerun after it"
    fi
  else
    record SKIP "built app" "run make bundle first"
  fi

  section "8. Distribution ($DMG)"
  if [ -n "$DMG" ] && [ -f "$DMG" ]; then
    if spctl -a -t install -vv "$DMG" >>"$LOG" 2>&1; then
      record PASS "Gatekeeper accepts DMG" ""
    else
      record WARN "Gatekeeper rejects DMG" "expected unless built by make notarize"
    fi
    if xcrun stapler validate "$DMG" >>"$LOG" 2>&1; then
      record PASS "notarization ticket stapled" ""
    else
      record WARN "no stapled ticket" "expected unless built by make notarize"
    fi
  else
    record SKIP "DMG" "run make dmg or make notarize first"
  fi
fi

# 9. Sanitizers (slow) -----------------------------------------------------------------------
section "9. Sanitizers"
if [ ${#SANITIZE_CMDS[@]} -eq 0 ]; then
  record SKIP "sanitizers" "not applicable to $PROJECT_TYPE"
elif [ $FULL -eq 1 ]; then
  for cmd in "${SANITIZE_CMDS[@]}"; do
    if bash -c "$cmd" >>"$LOG" 2>&1; then
      record PASS "sanitizer" "$cmd"
    else
      record FAIL "sanitizer" "$cmd; see $LOG"
    fi
  done
else
  record SKIP "sanitizers" "make security-audit FULL=1 (slow)"
fi

# Summary ------------------------------------------------------------------------------------
{
  echo
  echo "Summary"
  echo "-------"
  printf '%s\n' "${rows[@]}"
  echo
  echo "PASS $pass   FAIL $fail   WARN $warn   SKIP $skip"
} | tee -a "$LOG"

[ $fail -eq 0 ]

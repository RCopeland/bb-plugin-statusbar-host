#!/usr/bin/env bash
#
# Fail if a secret, a credential file, or a machine-local path has been
# committed.
#
# WHY THIS EXISTS
#
# This plugin reads a SQLite store and (in normal use) is developed on a machine
# that holds live API keys in its bb env store. The realistic accident is not
# someone writing `API_KEY = "..."` into src/ — it is a debug snippet that dumps
# the env store, or a copied `.env`, or a committed `data.db`, ending up in a
# commit. Review catches prose; it does not reliably catch a 40-character
# alphanumeric string.
#
# Same script runs locally and in CI, so a contributor finds the problem before
# pushing rather than from a red check.
#
# WHAT IT SCANS
#
# Only files GIT TRACKS (or would track). An untracked .env sitting in the
# working tree is fine and expected; a tracked one is the failure. This keeps
# the check honest about what actually ships.

set -euo pipefail

cd "$(dirname "$0")/.."

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: not a git repository; run this from the repo root" >&2
  exit 1
fi

fail=0
report() {
  echo "::error::$1" >&2
  fail=1
}

# ---------------------------------------------------------------------------
# 1. No sensitive PATHS tracked, by name.
# ---------------------------------------------------------------------------
#
# These are the file kinds that carry live values or another plugin's data.
# Matched against tracked paths, so an ignored-but-present file does not
# trigger a false alarm.
TRACKED="$(git ls-files)"

while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    .env.example) continue ;; # the one allowed exception, and it holds no values
    .env|.env.*|*.env|*.pem|*.key|*.p12|*.pfx|id_rsa*|id_ed25519*)
      report "tracked file looks like a credential file: $path" ;;
    *.db|*.db-wal|*.db-shm|*.sqlite|*.sqlite3)
      report "tracked file looks like a database (may contain usage data): $path" ;;
    *credentials*.json|*secrets*.json|*.token)
      report "tracked file looks like a credential store: $path" ;;
  esac
done <<< "$TRACKED"

# ---------------------------------------------------------------------------
# 2. No sensitive CONTENT in tracked text files.
# ---------------------------------------------------------------------------
#
# Known-format keys first: these have distinctive prefixes, so the pattern can
# be exact and never fires on prose. This is the check that would actually catch
# a real leak.
#
# Copyright/author names, version numbers, and long hashes are deliberately NOT
# matched: `package-lock.json` is full of 64-character hex strings and matching
# those would produce a scanner nobody trusts.

# Files worth scanning. Exclude the lockfile (integrity hashes would be noise),
# binary files, and build output.
text_files() {
  git ls-files -z \
    | grep -zvE '(^|/)(package-lock\.json|LICENSE)(\.|$)' \
    | xargs -0 -r grep -IlE '.' 2>/dev/null || true
}

KEY_PATTERNS=(
  # OpenRouter: `sk-or-v1-` followed by 64 hex.
  'sk-or-v1-[0-9a-fA-F]{32,}'
  # OpenAI / Anthropic style: `sk-`, `sk-ant-`, optional vendor segment.
  '(^|[^A-Za-z0-9-])sk-(ant-)?[A-Za-z0-9_-]{24,}'
  # GitHub tokens, classic and fine-grained.
  'gh[pousr]_[A-Za-z0-9]{36,}'
  'github_pat_[A-Za-z0-9_]{22,}'
  # AWS access key id.
  '(A3T[A-Z0-9]|AKIA|ASIA)[A-Z0-9]{16}'
  # Google API key.
  'AIza[0-9A-Za-z_-]{35}'
  # Slack tokens.
  'xox[baprs]-[0-9A-Za-z-]{10,}'
  # Private key blocks, any of them.
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
)

for pattern in "${KEY_PATTERNS[@]}"; do
  # `-I` skips binary, `-n` gives a line number, `-E` is ERE. The `|| true`
  # keeps `set -e` from aborting on the ordinary no-match case.
  matches="$(text_files | xargs -r grep -nIE "$pattern" 2>/dev/null || true)"
  if [ -n "$matches" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      report "possible credential matching /$pattern/: $line"
    done <<< "$matches"
  fi
done

# ---------------------------------------------------------------------------
# 3. No absolute home paths baked into source.
# ---------------------------------------------------------------------------
#
# This plugin locates host-monitor's store from bb's data directory, not from a
# baked-in path. A hardcoded `/home/<someone>/...` is both a portability bug and
# a small information leak about the author's machine, so it is worth catching
# here rather than in review.

home_matches="$(text_files | xargs -r grep -nIE '"/(home|Users)/[A-Za-z0-9._-]+/' 2>/dev/null || true)"
if [ -n "$home_matches" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    report "hardcoded home path in source (use homedir()): $line"
  done <<< "$home_matches"
fi

# ---------------------------------------------------------------------------
# 4. The working tree's tracked env files, if any, must be empty of values.
# ---------------------------------------------------------------------------

if [ -f .env.example ]; then
  # An example file is allowed to exist, but not to contain something that looks
  # like a live value. Blank, placeholder, and obviously-fake values are fine.
  bad="$(grep -nIE '^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]#]+' .env.example 2>/dev/null \
    | grep -vE '=(|""|"?"?(changeme|your-|xxx|placeholder|example|test|<))' || true)"
  if [ -n "$bad" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      report ".env.example appears to carry a real value, not a placeholder: $line"
    done <<< "$bad"
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "Secrets check failed. Nothing here should be committed." >&2
  echo "If a value was committed, rotate it — removing the file is not enough," >&2
  echo "because it stays in history." >&2
  exit 1
fi

echo "ok: no secrets, credential files, or machine paths tracked"

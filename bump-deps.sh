#!/usr/bin/env bash
# Bump pinned JSR/npm dependencies to the latest registry releases that
# have cleared the supply-chain quarantine window (Issue #441).
#
# Until #441 this ran `deno update --latest` directly, which pulls
# whatever the registry serves at that moment — no minimum-release-age
# gate. That is the supply-chain hole described in the issue: a malicious
# publish could land on Develop within minutes of the upstream maintainer
# being compromised.
#
# Now this script delegates to `bump_deps.ts`, which queries each pin's
# publish timestamp from the registry (npm.jsr.io for JSR packages,
# registry.npmjs.org for npm packages) and refuses to bump an external
# pin to a version younger than `VIBE_BUMP_QUARANTINE_HOURS` hours
# (default 24h). Internal `@stsoftware/*` packages bypass the gate so
# NEAT-AI / tags releases still land immediately.
#
# After the updater rewrites `deno.json`, `deno install` is invoked so
# the tracked `deno.lock` is refreshed for the new pin set (Issue #418
# — `quality.sh` runs `deno test --frozen`).
#
# Same role as stSoftwareAU/GRQ `bump-deps.sh`: run from the repo root,
# commit the resulting `deno.json` / `deno.lock` changes, then run
# `./quality.sh` before merging.
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "${ROOT}"

# Per supply-chain policy the default quarantine is 24h. Override via the
# environment so the policy stays auditable from the workflow file.
QUARANTINE_HOURS="${VIBE_BUMP_QUARANTINE_HOURS:-24}"

echo "bump_deps: quarantine window = ${QUARANTINE_HOURS}h (override via VIBE_BUMP_QUARANTINE_HOURS)"

# The only network reach the updater needs is the registries it consults:
# npm.jsr.io / registry.npmjs.org for publish timestamps, plus jsr.io to
# confirm a JSR candidate is resolvable by `deno install` before adopting
# it (Issue #362). Keep the allow-net list explicit so an unexpected
# outbound call would fail loudly.
deno run \
  --allow-read \
  --allow-write \
  --allow-env=VIBE_BUMP_QUARANTINE_HOURS \
  --allow-net=jsr.io,npm.jsr.io,registry.npmjs.org \
  bump_deps.ts \
  --config deno.json \
  --quarantine-hours "${QUARANTINE_HOURS}"

# Refresh the lockfile so `deno test --frozen` (and any other --frozen
# invocation) accepts the new pin set. `deno install` populates the lock
# from the import map without running tests.
deno install --quiet

echo "Dependency pins refreshed. Review git diff, run ./quality.sh, then commit."

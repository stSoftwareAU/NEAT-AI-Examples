#!/usr/bin/env bash
# Bump pinned JSR/npm dependencies to the latest registry releases.
# Equivalent to `deno outdated --update --latest` — Deno documents this as
# `deno update --latest` (see `deno update --help`).
#
# Same role as stSoftwareAU/GRQ `bump-deps.sh`: run from the repo root,
# commit the resulting `deno.json` and `deno.lock` changes, then run
# `./quality.sh` before merging. The lockfile is tracked so CI can use
# `--frozen` and reject silent transitive bumps (issue #418).
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "${ROOT}"

deno update --latest

echo "Dependency pins refreshed. Review git diff, run ./quality.sh, then commit."

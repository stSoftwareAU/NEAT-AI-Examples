#!/bin/bash
set -euo pipefail

# Bash syntax gate (Issue #768).
#
# Bash has no compile step, so a syntax error in a committed script only
# surfaces when someone runs it. ShellCheck lints style and common bugs
# but is not the parser; this gate runs `bash -n` (parse, do not execute)
# over every shell script so invalid bash fails the pull request instead
# of landing on the default branch.
#
# Usage: quality/bash_syntax.sh [ROOT]
#   ROOT defaults to the repository root (the parent of this script).
#
# Fails loud (Issue #3234): a missing root, an empty scan, or any script
# that does not parse exits non-zero. Every broken script is reported,
# not just the first.

ROOT="${1:-}"
if [ -z "${ROOT}" ]; then
  ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
fi

if [ ! -d "${ROOT}" ]; then
  echo "bash_syntax: root directory not found: ${ROOT}" >&2
  exit 1
fi

# Mirrors the ShellCheck workflow's discovery: skip VCS internals, the
# in-workspace NEAT-AI-core / NEAT-AI-scorer checkouts, and vendored
# dependencies — none of those are ours to gate.
scripts=()
while IFS= read -r -d '' script; do
  scripts+=("${script}")
done < <(
  find "${ROOT}" -name '*.sh' -type f \
    -not -path '*/.git/*' \
    -not -path '*/NEAT-AI-core/*' \
    -not -path '*/NEAT-AI-scorer/*' \
    -not -path '*/node_modules/*' \
    -print0
)

if [ "${#scripts[@]}" -eq 0 ]; then
  echo "bash_syntax: no shell scripts found under ${ROOT} — the discovery pattern is broken" >&2
  exit 1
fi

printf 'Syntax-checking %d script(s) under %s\n' "${#scripts[@]}" "${ROOT}"

failed=0
for script in "${scripts[@]}"; do
  if ! bash -n "${script}"; then
    echo "bash_syntax: syntax error in ${script}" >&2
    failed=1
  fi
done

if [ "${failed}" -ne 0 ]; then
  echo "bash_syntax: FAILED — one or more scripts do not parse" >&2
  exit 1
fi

printf 'bash_syntax: PASSED — %d script(s) parse cleanly\n' "${#scripts[@]}"

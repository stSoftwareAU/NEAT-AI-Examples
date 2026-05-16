#!/bin/bash
# Idempotently inject the "Monitor NEAT-AI" checklist item into the body of
# each re-evolve issue (#371-#390). The snippet is read verbatim out of
# docs/monitoring-neat-ai.md (between the MONITOR-NEAT-AI-START / END
# markers) rather than duplicated here, so the doc remains the single source
# of truth. See issue #394.
#
# Behaviour:
#   - For each target issue, fetch the body via `gh issue view`.
#   - If the body already contains the START marker, skip (idempotent).
#   - Otherwise, append the snippet to the end of the existing
#     `## Acceptance Criteria` block. If no such block is present, append a
#     new `## Acceptance Criteria` section at the end of the body.
#   - Update the issue via `gh issue edit --body-file`.
#   - Report a one-line summary per issue:
#       #NNN: injected | skipped (already present) | error: <message>
#   - Exit non-zero if any individual edit fails.
#
# Environment overrides (used by the unit test):
#   GH_BIN          path to the `gh` binary (defaults to `gh` on PATH)
#   REPO            target repository slug (defaults to stSoftwareAU/NEAT-AI-Examples)
#   ISSUES          space-separated list of issue numbers (defaults to 371..390)
#   SNIPPET_SOURCE  path to the Markdown file holding the snippet block
#                   (defaults to docs/monitoring-neat-ai.md)

set -euo pipefail

GH_BIN="${GH_BIN:-gh}"
REPO="${REPO:-stSoftwareAU/NEAT-AI-Examples}"
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -P "${SCRIPT_DIR}/.." && pwd -P)"
SNIPPET_SOURCE="${SNIPPET_SOURCE:-${REPO_ROOT}/docs/monitoring-neat-ai.md}"
ISSUES="${ISSUES:-$(seq 371 390 | tr '\n' ' ')}"

START_MARKER='<!-- MONITOR-NEAT-AI-START -->'
END_MARKER='<!-- MONITOR-NEAT-AI-END -->'

if [[ ! -f "${SNIPPET_SOURCE}" ]]; then
  echo "error: snippet source not found: ${SNIPPET_SOURCE}" >&2
  exit 2
fi

# Extract the snippet block (inclusive of both markers) from the source doc
# into a tempfile. We deliberately use a file rather than passing the
# multi-line snippet through `-v` because BSD awk (macOS default) rejects
# embedded newlines in `-v` variable values.
SNIPPET_FILE="$(mktemp)"
trap 'rm -f "${SNIPPET_FILE}"' EXIT

awk -v s="${START_MARKER}" -v e="${END_MARKER}" '
  $0 == s { inblock = 1 }
  inblock { print }
  $0 == e { inblock = 0; found = 1; exit }
  END { if (!found) exit 3 }
' "${SNIPPET_SOURCE}" > "${SNIPPET_FILE}"

if [[ ! -s "${SNIPPET_FILE}" ]]; then
  echo "error: failed to extract snippet from ${SNIPPET_SOURCE}" >&2
  exit 3
fi

# Build the new body by inserting the snippet at the end of the Acceptance
# Criteria section (or appending a new section if absent). Prints the new
# body to stdout. Reads the existing body from $1.
build_new_body() {
  local body_file="$1"
  awk -v snippet_file="${SNIPPET_FILE}" '
    function emit_snippet(   line) {
      while ((getline line < snippet_file) > 0) print line
      close(snippet_file)
    }
    {
      lines[NR] = $0
    }
    /^## Acceptance Criteria$/ {
      if (ac_heading == 0) ac_heading = NR
      next
    }
    ac_heading > 0 && next_section == 0 && /^## / {
      next_section = NR
    }
    END {
      total = NR
      if (ac_heading == 0) {
        # No Acceptance Criteria section: append a new one at the end.
        for (i = 1; i <= total; i++) print lines[i]
        if (total > 0 && lines[total] != "") print ""
        print "## Acceptance Criteria"
        print ""
        emit_snippet()
        exit 0
      }
      if (next_section == 0) {
        end_idx = total
      } else {
        end_idx = next_section - 1
      }
      # Trim trailing blank lines from the AC block so the snippet sits
      # flush at the end of the checklist.
      while (end_idx > ac_heading && lines[end_idx] == "") end_idx--
      for (i = 1; i <= end_idx; i++) print lines[i]
      print ""
      emit_snippet()
      if (end_idx < total) print ""
      for (i = end_idx + 1; i <= total; i++) print lines[i]
    }
  ' "${body_file}"
}

EXIT_CODE=0

for n in ${ISSUES}; do
  body_in="$(mktemp)"
  body_out="$(mktemp)"

  if ! "${GH_BIN}" issue view "${n}" --repo "${REPO}" --json body --jq '.body' > "${body_in}" 2>/dev/null; then
    echo "#${n}: error: failed to fetch issue body"
    EXIT_CODE=1
    rm -f "${body_in}" "${body_out}"
    continue
  fi

  if grep -qF "${START_MARKER}" "${body_in}"; then
    echo "#${n}: skipped (already present)"
    rm -f "${body_in}" "${body_out}"
    continue
  fi

  if ! build_new_body "${body_in}" > "${body_out}"; then
    echo "#${n}: error: failed to build new body"
    EXIT_CODE=1
    rm -f "${body_in}" "${body_out}"
    continue
  fi

  if ! "${GH_BIN}" issue edit "${n}" --repo "${REPO}" --body-file "${body_out}" >/dev/null 2>&1; then
    echo "#${n}: error: failed to edit issue"
    EXIT_CODE=1
    rm -f "${body_in}" "${body_out}"
    continue
  fi

  echo "#${n}: injected"
  rm -f "${body_in}" "${body_out}"
done

exit "${EXIT_CODE}"

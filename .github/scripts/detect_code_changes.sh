#!/usr/bin/env bash
# Classify a pull request's changed paths for per-job CI gating (Issue #888).
#
# Usage: detect_code_changes.sh <code|markdown> < changed-paths
#
# Reads one repository-relative path per line on stdin and prints `true`
# when the gated work is needed, `false` when it can safely be skipped.
#   code     — `false` only when every path is documentation or an image.
#   markdown — `true` when any path is Markdown or markdown-lint config.
# An empty list prints `true`: when in doubt, run the checks (fail safe).
set -euo pipefail

mode="${1:-}"
case "${mode}" in
  code | markdown) ;;
  *)
    echo "usage: $(basename "$0") <code|markdown> < changed-paths" >&2
    exit 2
    ;;
esac

# Documentation-only paths: nothing a build, test or scanner consumes.
is_docs_only() {
  case "$1" in
    *.md | *.png | *.jpg | *.jpeg | *.gif | *.svg | *.webp | LICENSE) return 0 ;;
    *) return 1 ;;
  esac
}

# Paths whose change can alter the markdown-lint verdict.
is_markdown_relevant() {
  case "$1" in
    *.md | .markdownlint-cli2.jsonc | .github/workflows/markdown-lint.yml) return 0 ;;
    .github/scripts/detect_code_changes.sh | .github/actions/detect-changes/*) return 0 ;;
    *) return 1 ;;
  esac
}

seen=0
while IFS= read -r path || [ -n "${path}" ]; do
  [ -z "${path}" ] && continue
  seen=1
  if [ "${mode}" = "code" ]; then
    if ! is_docs_only "${path}"; then
      echo true
      exit 0
    fi
  elif is_markdown_relevant "${path}"; then
    echo true
    exit 0
  fi
done

# No paths at all is not evidence of a docs-only change — run everything.
if [ "${seen}" -eq 0 ]; then
  echo true
else
  echo false
fi

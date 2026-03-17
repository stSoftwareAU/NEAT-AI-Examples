## Summary

Enhanced all documentation files with emojis, styling, and visual polish to make them fun,
informative, and factual. Closes #27.

### Changes

- **README.md** (primary focus):
  - Added CI status, licence, and Deno version badges at the top
  - Added relevant emojis to all section headers
  - Wrapped reference material (running tests, linting/formatting, unit tests vs benchmarks,
    running benchmarks, tacit knowledge) in collapsible `<details>` sections
  - Added GitHub admonition blocks (`> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`) where appropriate
  - Fixed American English "behavior" to Australian English "behaviour"
  - Updated licence section to use Australian English spelling ("Licence")

- **CONTRIBUTING.md** (secondary focus):
  - Added emojis to all section headers and numbered steps
  - Added a comprehensive Australian English spelling reference table with 16 common words
  - Added `> [!NOTE]` and `> [!TIP]` admonition blocks
  - Updated quality check link to match new emoji-prefixed anchor

- **AGENTS.md** (light touch):
  - Added emojis to all section headers
  - Updated quality check link to match new emoji-prefixed anchor

## Evidence

- All documentation uses Australian English consistently
- All section headers have relevant emojis
- README.md has 3 status badges (CI, licence, Deno)
- 5 collapsible `<details>` sections used for reference material
- 3 GitHub admonition blocks used (`> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`)
- `./quality.sh` passes cleanly — all lint, format, test, and example checks succeed

## Test Plan

- Verified all existing tests continue to pass (no code changes, documentation only)
- Ran `./quality.sh` — all checks pass (lint, format, unit tests, examples)
- Verified Australian English spelling throughout all documentation files

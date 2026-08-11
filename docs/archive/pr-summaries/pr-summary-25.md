## Summary

De-duplicated and unified documentation so that README.md is the single source of truth. Closes #25.

### Changes

- **CONTRIBUTING.md**: Removed duplicated content (quality gate steps, test commands, linting
  commands, testing guidelines) that was nearly identical to README.md. Replaced with concise
  references back to README.md sections. Retained contributor-specific content: detailed
  prerequisites, adding new examples, code style, and PR checklist.

- **AGENTS.md**: Condensed the "Running Quality Checks" section to a brief reference to README.md,
  removing the duplicated step-by-step breakdown. Kept all agent-specific content (testing
  philosophy, unit tests vs benchmarks, writing tests, project structure).

- **README.md**: Added a "Contributing" section that links to CONTRIBUTING.md for development setup,
  coding standards, and PR workflow. README remains the comprehensive reference for all user-facing
  information.

- **docs/archive_test.ts**: Updated to allow pr-summary-25.md in the docs root.

### Duplications Resolved

| Content Area                                   | Resolution                                          |
| ---------------------------------------------- | --------------------------------------------------- |
| Running tests (`deno test` commands)           | CONTRIBUTING.md references README.md                |
| Linting & formatting (`deno lint`, `deno fmt`) | CONTRIBUTING.md references README.md                |
| Quality gate steps                             | CONTRIBUTING.md references README.md                |
| Unit tests vs benchmarks guidance              | AGENTS.md kept (agent-specific audience)            |
| Australian English spelling rules              | CONTRIBUTING.md references AGENTS.md for full list  |
| Testing philosophy/guidelines                  | CONTRIBUTING.md references AGENTS.md                |
| CI information                                 | Removed from CONTRIBUTING.md (already in README.md) |

## Evidence

- All 117 unit tests pass including contributing_test.ts which validates CONTRIBUTING.md content
- `./quality.sh` passes cleanly (lint, format, tests, all examples)
- All internal cross-references and links verified

## Test Plan

- Existing `contributing_test.ts` (14 tests) validates CONTRIBUTING.md still contains all required
  sections and references
- Existing `docs/archive_test.ts` updated to allow pr-summary-25.md
- No new tests needed — this is a documentation-only change verified by existing test suite

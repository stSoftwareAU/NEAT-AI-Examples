## Summary

Analysed the NEAT-AI-Examples project and created 7 improvement suggestions as GitHub issues, as
requested in issue #7. Also added a `suggest_improvements/` module that codifies the analysis
process with full test coverage.

Closes #7.

### Issues Created

| Issue | Title                                                           | Category      |
| ----- | --------------------------------------------------------------- | ------------- |
| #8    | Add GitHub Actions CI/CD workflow                               | CI/CD         |
| #9    | Add Deno linting and formatting configuration                   | Code quality  |
| #10   | Make intelligent_design/generateSyntheticData deterministic     | Code quality  |
| #11   | Add a third example: Crossover / Breeding                       | New example   |
| #12   | Extract shared utilities into a common module                   | Code quality  |
| #13   | Add CONTRIBUTING.md with development setup guide                | Documentation |
| #14   | Add benchmark tests for creature activation and data generation | Enhancement   |

### Changes

- Added `suggest_improvements/suggest_improvements.ts` — project analyser that identifies
  improvement opportunities and outputs structured suggestions
- Added `suggest_improvements/suggest_improvements_test.ts` — 12 unit tests verifying the analysis
  and summary generation functions
- Added `suggest_improvements/run.sh` — runner script for the example
- Updated `quality.sh` to include the suggest improvements example
- Updated `AGENTS.md` project structure to document the new module
- Updated `README.md` with documentation for the suggest improvements example

## Evidence

This is a CLI/analysis tool with no visual output. Evidence is provided by:

- All 41 unit tests passing (12 new + 29 existing)
- All 3 example programs completing successfully
- `quality.sh` passes cleanly

## Test Plan

- 12 new tests in `suggest_improvements/suggest_improvements_test.ts`:
  - `analyseProject` returns improvements with required fields
  - `analyseProject` includes CI/CD, code quality, documentation, and new example suggestions
  - `analyseProject` improvements have unique titles
  - `analyseProject` summary is non-empty
  - `writeImprovementsSummary` creates a valid markdown file
  - `writeImprovementsSummary` output contains improvement titles and summary
  - `writeImprovementsSummary` output contains markdown headings
- All 29 existing tests continue to pass unchanged

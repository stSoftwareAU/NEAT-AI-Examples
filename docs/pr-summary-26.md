## Summary

Add mermaid diagrams to documentation to visually illustrate key concepts and workflows.
Closes #26.

Four mermaid diagrams added to README.md:

1. **Examples Overview** — Flowchart showing how the NEAT-AI library feeds into common utilities,
   which in turn feed into all four example modules
2. **Quality Check Pipeline** — Flowchart showing the quality.sh pipeline: lint, format check,
   unit tests, example runners (with pass/fail paths)
3. **Project Architecture** — Flowchart showing the common/ module internals (PRNG, synthetic
   data, working dirs) feeding into each example module
4. **Intelligent Design Workflow** — Flowchart showing the step-by-step process: create creature,
   generate data, score baseline, scan neurons, try alternatives, combine improvements

One diagram added to CONTRIBUTING.md:

5. **New Example Structure** — Flowchart showing the three-file pattern for adding a new example
   (module, test, runner) and its connections to common/, quality.sh, and README.md

All diagrams use emojis, colourful styling, and Australian English labels. They render natively
on GitHub via mermaid syntax.

## Evidence
- All 124 unit tests pass, including 7 new mermaid diagram tests
- `quality.sh` passes cleanly (lint, format, tests, all example runners)
- Diagrams are factually accurate based on actual code structure and workflows

## Test Plan
- Added `mermaid_diagrams_test.ts` with 7 tests:
  - Verifies at least 3 mermaid diagrams exist in README.md
  - Validates all mermaid blocks have a valid diagram type declaration
  - Checks no mermaid block is empty
  - Verifies diagrams cover the example modules (Intelligent Design, Discovery, Crossover)
  - Verifies diagrams cover the quality check pipeline (lint, tests)
  - Verifies diagrams cover the project architecture (common module)
  - Checks diagrams use emojis for visual engagement

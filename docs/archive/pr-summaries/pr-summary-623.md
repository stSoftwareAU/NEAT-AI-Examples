## Summary

Removed the dead exported constant `POSE_MARKER_COUNT` (and its leading JSDoc comment) from
`lunar_lander/svg.ts`. The symbol had no importer anywhere in the repository and was unreferenced
within its own module. A repo-wide token search confirmed a single occurrence — its own declaration
— with no string, dynamic, or reflective lookup of the identifier in any `.ts`, `.sh`, `.md`, or
`.json` file. The sibling constant `ANIMATION_DURATION_SECONDS` is genuinely used and was left
untouched. Closes #623.

## Evidence

Backend/CLI change with no web interface to screenshot. Verified via the project's quality gates:

- `deno fmt --check` — clean
- `deno lint` — clean (168 files)
- `deno check ./**/*.ts` — clean
- `deno test --parallel` — `1183 passed | 0 failed`

The `lunar_lander/` test suite continues to pass, confirming the SVG renderer still functions
without the removed constant.

No regression test was added: this is a pure dead-code deletion with no behaviour change, and
`AGENTS.md` forbids "how" tests that grep source for the absence of a symbol. Correctness is covered
by the existing module tests, which exercise the real `svg.ts` exports and pass after the removal.

## Test Plan

- Ran the full unit suite (`deno test --parallel --allow-all`): 1183 passed, 0 failed.
- Ran the `lunar_lander/` suite specifically: all tests pass.
- Confirmed `deno fmt`, `deno lint`, and `deno check` are clean across the repo.

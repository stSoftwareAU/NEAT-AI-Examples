## Summary

Add explicit Deno linting and formatting configuration to ensure consistent code style across
contributors. Closes #9.

### Changes

- **`deno.json`** — Added `lint` section with recommended rules and `fmt` section specifying 2-space
  indentation, 100-character line width, and double quotes. Added `@std/yaml` as a mapped import to
  replace an inline `jsr:` specifier.
- **`quality.sh`** — Added `deno lint` and `deno fmt --check` steps before unit tests, so code style
  issues are caught early in the quality gate.
- **`.github/workflows/quality.yml`** — Added lint and format check steps to the CI workflow.
- **`lint_fmt_config_test.ts`** — 11 new tests verifying the deno.json configuration and quality.sh
  integration.
- **`.github/workflows/quality_test.ts`** — 2 new tests verifying the CI workflow includes lint and
  format steps. Fixed inline import to use the bare specifier from deno.json.
- **`suggest_improvements/suggest_improvements_test.ts`** — Removed unused `ensureDirSync` import
  flagged by the linter.
- **`AGENTS.md`** and **`README.md`** — Updated documentation to describe the new lint and format
  quality checks.
- All existing source files reformatted to comply with the new `deno fmt` configuration.

## Evidence

This is a backend/CLI project with no web interface. Evidence is the test output from
`./quality.sh`:

- `deno lint` passes cleanly (8 files checked)
- `deno fmt --check` passes cleanly (15 files checked)
- All 52 unit tests pass (13 new + 39 existing)
- All 3 example programs run successfully

## Test Plan

- Added `lint_fmt_config_test.ts` with 11 tests:
  - Verifies `deno.json` has `lint` section with recommended rules
  - Verifies `deno.json` has `fmt` section with correct settings (useTabs, lineWidth, indentWidth,
    singleQuote)
  - Verifies `quality.sh` includes `deno lint` and `deno fmt --check`
  - Verifies lint and format checks run before unit tests in quality.sh
- Added 2 tests to `.github/workflows/quality_test.ts`:
  - Verifies workflow runs `deno lint`
  - Verifies workflow runs `deno fmt --check`

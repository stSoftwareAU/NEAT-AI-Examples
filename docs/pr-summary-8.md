## Summary

Add a GitHub Actions CI/CD workflow that automates quality checks on every push and pull request to
the `Develop` branch. This prevents regressions by ensuring unit tests and example programs are
validated before merging. Closes #8.

### What changed

- **`.github/workflows/quality.yml`** — New workflow that:
  - Triggers on push and pull request to `Develop`
  - Installs Deno and caches dependencies
  - Runs `deno test` (unit tests)
  - Runs all three example programs (Intelligent Design, Discovery, Suggest Improvements)
  - Discovery step uses `continue-on-error: true` because it requires a native Rust FFI library not
    yet available in CI
- **`.github/workflows/quality_test.ts`** — Tests that parse and validate the workflow YAML
  structure
- **`README.md`** — Added a Continuous Integration section documenting the automated workflow

## Evidence

This is a backend/CI configuration change with no visual output. Evidence:

- All 7 workflow validation tests pass, confirming the YAML is well-formed and contains the required
  configuration (triggers, Deno setup, test execution, example programs)
- `quality.sh` passes cleanly with all existing and new tests

## Test Plan

- Added `quality_test.ts` with 7 tests that parse the workflow YAML and verify:
  - File exists and is valid YAML
  - Workflow has a descriptive name
  - Triggers on push and pull_request to the Develop branch
  - Defines at least one job
  - Installs Deno via the setup-deno action
  - Runs `deno test`
  - Runs all three example programs (Intelligent Design, Discovery, Suggest Improvements)

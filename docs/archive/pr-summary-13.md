## Summary

Add a comprehensive CONTRIBUTING.md contributor guide to the repository root. The guide covers
development environment setup (Deno, Rust FFI library with platform-specific paths for macOS and
Linux), the development workflow (running tests, lint, format, and the quality gate), a step-by-step
guide for adding new examples following the established three-file pattern (module, tests, runner
script), testing guidelines with references to AGENTS.md for the full "what" vs "how" philosophy,
Australian English spelling requirement, and a pull request checklist. Closes #13.

## Evidence

This is a documentation-only change with no UI or performance impact. The CONTRIBUTING.md file and
its tests were verified by running `./quality.sh`, which passed all checks: lint, format, unit
tests, and all example programs.

## Test Plan

- Added `contributing_test.ts` with 14 tests verifying CONTRIBUTING.md content:
  - File exists and is non-empty
  - Covers Deno installation prerequisite
  - Covers Rust library for discovery
  - Includes platform-specific library paths (macOS `.dylib`, Linux `.so`)
  - Covers running tests (`deno test`)
  - Covers linting (`deno lint`)
  - Covers formatting (`deno fmt`)
  - Covers the `quality.sh` script
  - Has a section about adding new examples
  - Mentions the example file pattern (`_test.ts`, `run.sh`)
  - References AGENTS.md for testing philosophy
  - Mentions what vs how tests
  - Mentions Australian English spelling requirement
  - Has a PR checklist or review section

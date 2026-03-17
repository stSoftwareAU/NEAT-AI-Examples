## Summary

Moved all 9 existing PR summary files from `docs/` to `docs/archive/` to declutter the documentation
directory. Closes #24.

### Files moved

- `docs/pr-summary-5.md` → `docs/archive/pr-summary-5.md`
- `docs/pr-summary-7.md` → `docs/archive/pr-summary-7.md`
- `docs/pr-summary-8.md` → `docs/archive/pr-summary-8.md`
- `docs/pr-summary-9.md` → `docs/archive/pr-summary-9.md`
- `docs/pr-summary-10.md` → `docs/archive/pr-summary-10.md`
- `docs/pr-summary-11.md` → `docs/archive/pr-summary-11.md`
- `docs/pr-summary-12.md` → `docs/archive/pr-summary-12.md`
- `docs/pr-summary-13.md` → `docs/archive/pr-summary-13.md`
- `docs/pr-summary-14.md` → `docs/archive/pr-summary-14.md`

No references to these files were found elsewhere in the codebase, so no link updates were needed.

## Evidence

All acceptance criteria verified:

- `docs/archive/` directory exists with all 9 PR summary files
- No PR summary files remain in `docs/` root
- No broken links (no references existed)
- Quality checks pass

## Test Plan

- Added `docs/archive_test.ts` with two tests:
  - Verifies all 9 PR summary files exist in `docs/archive/`
  - Verifies no PR summary files remain in `docs/` root (excluding `pr-summary-24.md`)

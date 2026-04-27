## Summary

Added a Gitleaks Secrets Detection GitHub Actions workflow at `.github/workflows/gitleaks.yml` that
scans every pull request for accidentally committed secrets such as API keys, tokens, and
credentials. The workflow checks out the full git history (`fetch-depth: 0`) so that secrets
introduced in any commit on the PR branch are detected, and runs with read-only `contents`
permissions.

Closes #33.

## Evidence

This is a CI/CD configuration change with no web UI. Verification was done by parsing the workflow
YAML and asserting on its structure via a new Deno test suite.

```mermaid
flowchart LR
    PR[Pull Request] --> CO[actions/checkout@v4<br/>fetch-depth: 0]
    CO --> GL[gitleaks/gitleaks-action@v2]
    GL -->|secrets found| Fail[Fail PR check]
    GL -->|clean| Pass[Pass PR check]
```

Test run output:

```
running 7 tests from ./.github/workflows/gitleaks_test.ts
gitleaks workflow file exists and is valid YAML ... ok
gitleaks workflow has a descriptive name ... ok
gitleaks workflow triggers on pull_request events ... ok
gitleaks workflow declares read-only contents permission ... ok
gitleaks workflow defines a gitleaks job ... ok
gitleaks workflow checks out the full git history ... ok
gitleaks workflow runs the gitleaks-action ... ok
ok | 7 passed | 0 failed
```

## Test Plan

- Added `.github/workflows/gitleaks_test.ts` covering:
  - Workflow file exists and parses as valid YAML.
  - Workflow has a `name` field.
  - Workflow triggers on `pull_request`.
  - Workflow declares `contents: read` permissions.
  - Workflow defines at least one job.
  - Checkout step uses `fetch-depth: 0` for full history scanning.
  - A `gitleaks/gitleaks-action@*` step is present.

## Notes on quality.sh

`./quality.sh` reports two pre-existing failures on `Develop` that are not caused by this change:

- `docs/archive_test.ts` fails because `docs/pr-summary-32.md` was merged to `Develop` (commit
  `a534225`) without being added to the allowlist in that test.
- The Crossover example is intermittently flaky (it passes when run directly).

Both are out of scope for this issue. The new gitleaks tests pass cleanly, and `deno lint` /
`deno fmt --check` pass on the new files.

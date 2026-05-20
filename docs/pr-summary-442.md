## Summary

Pinned the `markdownlint-cli2` install in `.github/workflows/markdown-lint.yml` to an exact version
(`0.22.1`) instead of resolving npm's mutable `latest` tag on every CI run. The unpinned
`npm install -g markdownlint-cli2` step silently undid the 40-char SHA pins on `actions/checkout`
and `actions/setup-node` in the same workflow — a compromise of the `markdownlint-cli2` package
would have executed on the next PR run. Closes #442.

Version `0.22.1` was published on 2026-04-22, ~28 days before this change on 2026-05-20, so it is
well past the project's 24h `VIBE_BUMP_QUARANTINE_HOURS` window for external dependencies. A comment
in the workflow points future bumpers at the same quarantine policy and flags that this pin is not
maintained by the `deno-outdated` bot.

## Evidence

This is a CI-config change with no web interface to screenshot. The fix is covered by a unit test
that parses the workflow YAML and asserts the install step pins `markdownlint-cli2` to an exact
`MAJOR.MINOR.PATCH` version (rejecting bare names, `@latest`, `@next`, and range specifiers).

Test output (before the fix — failure reproduces the issue):

```
markdown-lint workflow — markdownlint-cli2 install is version-pinned (#442) ... FAILED
  AssertionError: install step must pin markdownlint-cli2 to an exact
  version (got: npm install -g markdownlint-cli2)
```

Test output (after the fix):

```
running 3 tests from ./.github/markdown_lint_workflow_test.ts
markdown-lint workflow — triggers on push to Develop ... ok
markdown-lint workflow — triggers on pull_request to any branch ... ok
markdown-lint workflow — markdownlint-cli2 install is version-pinned (#442) ... ok

ok | 3 passed | 0 failed
```

```mermaid
flowchart LR
    A[PR opened] --> B[checkout@SHA]
    B --> C[setup-node@SHA]
    C --> D["npm install -g markdownlint-cli2@0.22.1"]
    D --> E[markdownlint-cli2 run]
    style D fill:#cfc,stroke:#383
```

The supply-chain surface is now uniform across the workflow: every third-party step — actions and
npm packages alike — is pinned to a specific, audited revision.

## Test Plan

- Added
  `.github/markdown_lint_workflow_test.ts::markdown-lint workflow — markdownlint-cli2 install is version-pinned (#442)`.
  The test:
  - Parses `.github/workflows/markdown-lint.yml`.
  - Finds every step whose `run` block installs `markdownlint-cli2` (covers `npm install`, `npm i`,
    and `npx --package=...` forms).
  - Asserts the step references `markdownlint-cli2@<MAJOR.MINOR.PATCH>`.
  - Explicitly rejects `markdownlint-cli2@latest` and `markdownlint-cli2@next` even if a pinned
    version also appears in the same line (defence in depth).
- Reproduced the failure on the unfixed workflow and verified it now passes against the pinned
  `markdownlint-cli2@0.22.1` install step.
- All 15 pre-existing workflow tests in `.github/` continue to pass.

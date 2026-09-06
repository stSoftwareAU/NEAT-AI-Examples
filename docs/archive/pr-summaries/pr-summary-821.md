## Summary

The `shellcheck` job's `actions/checkout` step ran without `persist-credentials: false`, so checkout
wrote the workflow `GITHUB_TOKEN` into `.git/config` as an auth header where any later step in the
job could read it back and act as the token. The job only lints the checked-out shell scripts — it
never pushes to the repository and fetches no private submodule — so the persisted credential bought
nothing and only widened the blast radius of a compromised step.

Added `persist-credentials: false` to that checkout, with a comment recording why the job does not
need the credential. Closes #821.

## Evidence

No web interface to screenshot — this is a CI workflow change. The deliverable is the workflow YAML,
so the evidence is the new parsing test, which was observed failing against the unfixed workflow
(`persist-credentials` actual `undefined`, expected `false`) and passing after the fix:

```text
running 2 tests from ./shellcheck_workflow_credential_test.ts
shellcheck.yml shellcheck job — every checkout drops the credential ... ok (3ms)
shellcheck.yml shellcheck job — no step pushes back to the repository ... ok (773µs)

ok | 2 passed | 0 failed (6ms)
```

## Test Plan

- Added `shellcheck_workflow_credential_test.ts`:
  - `shellcheck.yml shellcheck job — every checkout drops the credential` — parses the workflow and
    asserts every `actions/checkout` step in the `shellcheck` job sets `persist-credentials: false`.
  - `shellcheck.yml shellcheck job — no step pushes back to the repository` — guards the premise of
    the fix: no step in the job runs `git push`, so dropping the credential cannot break it.

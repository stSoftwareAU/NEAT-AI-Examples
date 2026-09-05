# Job `unit-tests` — NEAT-AI-core checkout no longer persists the token

## Summary

The `unit-tests` job of `.github/workflows/quality.yml` had one remaining `actions/checkout` step
without `persist-credentials: false` — the `stSoftwareAU/NEAT-AI-core` path-dependency checkout.
`actions/checkout` writes the workflow `GITHUB_TOKEN` into `NEAT-AI-core/.git/config` as an auth
header by default, and this job runs the pull request's own test suite with `--allow-run=...,git`,
so any test could read it back with a single
`git config --get http.https://github.com/.extraheader`.

Nothing in the job pushes to NEAT-AI-core or fetches a private submodule from it — cargo only reads
the checked-out sources — so the persisted credential buys nothing and only widens the blast radius
of a compromised step. Added `persist-credentials: false` to that checkout. Closes #819.

The sibling checkouts were fixed under #815–#818; this completes the job.

## Evidence

Backend/CI-config change with no web interface to screenshot. Evidence is the test that was observed
failing before the fix and passing after it:

```
$ deno test --allow-read quality_workflow_unit_tests_credential_test.ts   # before the fix
error: AssertionError: Values are not equal: checkout step "Check out NEAT-AI-core
(path dependency for neat-core)" must set persist-credentials: false ...
FAILED | 3 passed | 1 failed
```

```
$ deno test --allow-read quality_workflow_unit_tests_credential_test.ts \
    quality_workflow_static_checks_credential_test.ts \
    quality_workflow_examples_credential_test.ts \
    deno_workflow_credential_scope_test.ts \
    workflow_secret_job_isolation_test.ts                                 # after the fix
ok | 22 passed | 0 failed
```

Full gate: `./quality.sh` — Deno Format, Bash Syntax (36 scripts), Deno Lint, Deno Type Check and
the Unit Tests stage (`1427 passed | 0 failed`) all pass. The example stages all fail identically in
this container with `ERROR: rustup installation appears incomplete` before any example code runs —
an environment fault affecting all 20 examples equally, unrelated to a YAML `with:` key and a
workflow test. CI runs the same gate on a runner with a working Rust toolchain.

## Test Plan

- Added
  `quality_workflow_unit_tests_credential_test.ts::quality.yml unit-tests
  job — every checkout drops the credential`
  — parses the workflow YAML and asserts **every** `actions/checkout` step in the `unit-tests` job
  sets `persist-credentials: false`, so a future checkout added to this job cannot reintroduce the
  leak. Observed failing against the unfixed workflow (see Evidence) and passing after it.
- Existing `unit-tests`, `static-checks` and `examples` credential tests are unchanged and still
  pass.

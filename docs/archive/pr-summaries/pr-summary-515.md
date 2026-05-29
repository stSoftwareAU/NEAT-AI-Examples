## Summary

The top-level `README.md` described the MNIST example as a "196 → 10 logistic
classifier" on a "14×14 down-sample," but `mnist_classification/data.ts`
defines `FEATURE_COUNT = 28 * 28 = 784` and seeds `new Creature(784, 10)`
trained on the full 60 000-record MNIST training set. This PR brings the
README in line with the code so first-time readers are not misled by
stale wording. Closes #515.

Changes:

- `README.md:233` — MNIST example table row now reads "Evolve a 784 → 10
  logistic classifier on the full 28×28 MNIST training set (60 000 images)…"
- `README.md:412` — capabilities diagram node now reads "Classify
  handwritten digits from the full 28×28 input".

## Evidence

Backend/docs change — no UI to screenshot. Verified via a new Deno test
that reads the on-disk `README.md` and asserts the corrected wording:

- `mnist_classification/mnist_classification_test.ts` —
  `top-level README MNIST entries match the real 784 / 28×28 code (Issue #515)`.
  The test fails against the pre-fix README (asserts the stale
  "196 → 10" string is gone) and passes against the corrected README.

`./quality.sh` exits cleanly ("All examples passed!").

## Test Plan

- Added `top-level README MNIST entries match the real 784 / 28×28 code
  (Issue #515)` to `mnist_classification/mnist_classification_test.ts`.
- Confirmed the test fails before the README edit and passes after.
- Confirmed `./quality.sh` runs cleanly end-to-end.

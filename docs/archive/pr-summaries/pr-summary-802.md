## Summary

Adds a multi-hour MNIST post-evolution campaign that alternates
[NEAT-AI-Lamarck](https://github.com/stSoftwareAU/NEAT-AI-Lamarck) and
[NEAT-AI-Backpropagation](https://github.com/stSoftwareAU/NEAT-AI-Backpropagation) under a shared
**MSE** scoring contract, then refreshes the published champion artefacts / README to the current
hold-out numbers.

### Campaign tooling

| Path                                         | Purpose                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/mnist_lamarck_backprop_campaign.sh` | Alternating Lamarck (plain `rust_scorer` / MSE + Phase-0 parity) and Backpropagation train slices; promotions gated on hold-out test accuracy |
| `scripts/mnist_holdout_score.ts`             | Hold-out scorer + `--compare` helper used by the campaign gate                                                                                |

### Measured 3-hour MSE run

- Baseline / final champion: **30.68%** test / **31.00%** val (795 neurons / 7,709 synapses).
- 8 Lamarck slices + 7 backprop slices completed; **0** hold-out promotions.
- Lamarck improved train MSE (Phase-0 parity green) but candidates typically dropped hold-out to
  ~27.3%; backprop candidates typically dropped to ~30.2%. The gate correctly kept the incumbent.
- README “Latest measured run” table and prediction-grid SVG refreshed to match `run_summary.json`.

### Why MSE (not CROSS_ENTROPY)

Lamarck’s Phase-0 parity check compares local MSE to the scorer error. Driving the scorer with
`CROSS_ENTROPY` fails that gate; the campaign therefore uses the plain `rust_scorer` MSE default so
parity, Lamarck acceptance, and Backpropagation train all share one loss.

## Summary

Ran [NEAT-AI-Backpropagation](https://github.com/stSoftwareAU/NEAT-AI-Backpropagation) `train` over
every supervised forward-only example that can emit a labelled `.bin` stream, then refreshed the
committed champions and prediction screenshots where hold-out metrics improved.

RL / routing examples (`cart_pole`, `mountain_car`, `snake_game`, `maze_navigation`, `lunar_lander`,
`tsp_*`) stay out of scope — they have no fixed `{input,target}` `.bin` corpus for the trainer.

### Committed artefact updates

| Example                | Train MSE / hold-out                                              | Artefacts                                                                       |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `xor_classification`   | MSE `9.09e-5` → `9.04e-5` (still 4/4 correct)                     | `creature.json`, `xor_decision_boundary.svg`                                    |
| `stock_market`         | train MSE `0.47019` → `0.46854`; val balanced `50.83%` → `51.75%` | `creature.json`, `stock_market.svg`                                             |
| `mnist_classification` | test `28.66%` → `29.53%`, val `29.44%` → `29.77%`                 | `creature.json`, `run_summary.json`, prediction grid + chart SVGs, README table |

### Other supervised examples trained (no committed champion to refresh)

| Example                       | Baseline MSE | Best MSE | Accepted epochs |
| ----------------------------- | ------------ | -------- | --------------- |
| `adaptive_mutation`           | 0.04483      | 0.04455  | 1               |
| `discovery_at_scale`          | 0.004924     | 0.004923 | 6               |
| `memetic_evolution`           | 0.001788     | 0.001306 | 13              |
| `mcmc_acceptance`             | 0.01938      | 0.01935  | 2               |
| `discovery`                   | 0.4776       | 0.4692   | 25              |
| `crispr_injection`            | 0.6325       | 0.6271   | 25              |
| `evolution_showcase`          | 4.689        | 4.254    | 25              |
| `crossover`                   | 0.1448       | 0.1407   | 25              |
| `synthetic_synapse`           | 3.409        | 3.062    | 25              |
| `suggest_improvements`        | 0.4701       | 0.3971   | 25              |
| `neuron_pruning`              | 0.004945     | 0.004945 | 0               |
| `intelligent_design`          | 0.000147     | 0.000147 | 0               |
| `memetic_evolution` (control) | 0.004519     | 0.004519 | 0               |

These examples only commit evolution-summary SVGs (or no champion under `docs/data/`), so
weight-only refines do not change the published charts.

### Reproduce renders

```bash
deno run --allow-read --allow-write --allow-net --allow-env \
  scripts/backprop_refresh_forward_only.ts render-xor
deno run --allow-read --allow-write --allow-net --allow-env \
  scripts/backprop_refresh_forward_only.ts render-stock
./mnist_classification/regenerate_recorded_artefacts.sh
```

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This repository is
a suite of worked examples rather than a published package, so it carries no version tags — notable
changes land under `[Unreleased]` and stay there. Each entry cites the issue that drove it, so the
full rationale is one click away.

## [Unreleased]

### Added

- `CHANGELOG.md` — a single chronological record of notable changes, replacing archaeology across
  issue threads and `AGENTS.md` exception notes (#721).

### Changed

- The PR-summary archive is now a single corpus at `docs/archive/pr-summaries/pr-summary-<PR>.md`;
  the 195 summaries that sat loose in `docs/archive/` moved there and `CONTRIBUTING.md` records the
  convention (#792).
- MNIST training/selection cost switched from `CATEGORICAL_ERROR` (non-differentiable
  `1 − argmax accuracy`) to `CROSS_ENTROPY` (softmax + cross-entropy). Top-1 argmax accuracy is
  still reported but no longer drives evolution (#523).
- Fresh-run seeds for `mnist_classification`, `stock_market`, `adaptive_mutation`,
  `discovery_at_scale`, `memetic_evolution`, and `crossover` now use the data-derived
  `Creature.forDataset(...)` factory instead of the legacy bare constructors. Seed weights and
  biases stay random and all structural growth beyond the seed still comes from the unchanged
  mutation operators — see [`docs/factory_adoption.md`](docs/factory_adoption.md) (#517).
- `@stsoftware/neat-ai` pinned to `6.0.3`, picking up the upstream `FineTunePopulation` fix that
  rejected a legitimate score of exactly `0` and broke `./adaptive_mutation/run.sh` (#702).

### Documented

- The PR-summary archive is consolidated at `docs/archive/pr-summaries/pr-summary-<PR>.md`; the 195
  summaries stranded on the old flat `docs/archive/` path moved into it, and
  [`CONTRIBUTING.md`](CONTRIBUTING.md) now names that path as the convention (#792).
- Milestones — the return value of `evolveDir` and the `evolverl_milestone` events from `evolveRL` /
  `evolveEnv` — are the supported telemetry surface for the noise → competent story (#298).
- [`docs/event-driven-evolution.md`](docs/event-driven-evolution.md) now records the five
  reinforcement examples as migrated (they all call `Creature.evolveRL()`) instead of showing an
  unticked scoreboard, and names `evolveRL()` rather than `evolveEnv()` as the event-driven API
  (#787).
- [`docs/factory_adoption.md`](docs/factory_adoption.md) now records `evolution_showcase` as
  migrated (#534 shipped), charts Group A as complete, and names Group B/C as the open remainder
  instead of deferring them "once Group A is complete" (#788).
- [`docs/neat_ai_feature_audit.md`](docs/neat_ai_feature_audit.md) refreshed so it stops
  contradicting the README that declares it the source of truth: the binary `.bin` row names the
  twelve emitting examples, the MNIST and synthetic-synapse rows are marked resolved with their
  superseded wording struck through, and the register lists the two missing TSP READMEs (#790).

# 🧠 NEAT-AI-Examples

[![Quality Check](https://github.com/stSoftwareAU/NEAT-AI-Examples/actions/workflows/quality.yml/badge.svg?branch=Develop)](https://github.com/stSoftwareAU/NEAT-AI-Examples/actions/workflows/quality.yml)
[![Licence](https://img.shields.io/badge/licence-Apache%202.0-blue.svg)](LICENSE)
[![Deno](https://img.shields.io/badge/Deno-2.x-black?logo=deno)](https://deno.land/)

Worked examples for [`NEAT-AI`](https://github.com/stSoftwareAU/NEAT-AI). Each example is a small,
self-contained program that generates its own synthetic data, so you can run it immediately with no
external dependencies beyond Deno (and, for Discovery, the NEAT-AI-Discovery Rust library).

This page is the **what** and **how** at a glance. Follow the link in each row for the full
walkthrough — the per-example README explains the workflow, options, and output artefacts.

## 🧬 Examples at a Glance

| Example                                                   | What it shows                                                                                            | How to run                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------- |
| [🧬 Intelligent Design](intelligent_design/README.md)     | Systematically swap activation functions on hidden neurons to find better squashes than random mutation. | `./intelligent_design/run.sh`   |
| [🔍 Discovery](discovery/README.md)                       | Cripple a creature by removing a neuron, then use evolutionary search to recover its behaviour.          | `./discovery/run.sh`            |
| [🔀 Crossover](crossover/README.md)                       | Breed two parents with different architectures into an offspring and (optionally) evolve it further.     | `./crossover/run.sh`            |
| [🎢 Cart-Pole](cart_pole/README.md)                       | Evolve a controller that balances an inverted pole on a moving cart and render the run as an SVG strip.  | `./cart_pole/run.sh`            |
| [💡 Suggest Improvements](suggest_improvements/README.md) | Analyse the project and emit categorised improvement suggestions you can file as GitHub issues.          | `./suggest_improvements/run.sh` |

```mermaid
flowchart TD
    NEAT["🧠 NEAT-AI Library"]
    COMMON["📦 Common Utilities<br/>Shared data generation,<br/>scoring & directory setup"]

    ID["🧬 Intelligent Design<br/>Optimise activation functions<br/>for hidden neurons"]
    DISC["🔍 Discovery<br/>Recover missing neurons<br/>via evolutionary search"]
    CROSS["🔀 Crossover<br/>Breed two creatures<br/>to produce offspring"]
    SUGGEST["💡 Suggest Improvements<br/>Analyse project &<br/>generate suggestions"]

    NEAT --> COMMON
    COMMON --> ID
    COMMON --> DISC
    COMMON --> CROSS
    COMMON --> SUGGEST

    style NEAT fill:#4a90d9,stroke:#333,color:#fff
    style COMMON fill:#f5a623,stroke:#333,color:#fff
    style ID fill:#7ed321,stroke:#333,color:#fff
    style DISC fill:#bd10e0,stroke:#333,color:#fff
    style CROSS fill:#e74c3c,stroke:#333,color:#fff
    style SUGGEST fill:#50e3c2,stroke:#333,color:#fff
```

## 📦 Shared Utilities

The [`common/`](common/) module provides the building blocks every example reuses:

- 🎲 **`deterministic_random.ts`** — splitmix32-style seeded PRNG so runs are reproducible across
  machines.
- 📊 **`synthetic_data.ts`** — `generateSyntheticData` and `scoreCreature`. Each example picks its
  own seed so data sets are independent but deterministic.
- 📁 **`working_dirs.ts`** — `setupWorkingDirs` creates `data/`, `creatures/`, and `output/`
  subdirectories under a per-example hidden root and clears `output/` on each run.

```mermaid
flowchart BT
    subgraph common ["📦 common/"]
        RNG["🎲 deterministic_random.ts<br/>Seeded PRNG"]
        DATA["📊 synthetic_data.ts<br/>Data generation & scoring"]
        DIRS["📁 working_dirs.ts<br/>Directory setup"]
    end

    subgraph examples ["🧬 Example Modules"]
        ID["🧬 intelligent_design/"]
        DISC["🔍 discovery/"]
        CROSS["🔀 crossover/"]
        SUGGEST["💡 suggest_improvements/"]
    end

    RNG --> DATA
    common --> ID
    common --> DISC
    common --> CROSS
    common --> SUGGEST

    style common fill:#fff3cd,stroke:#f5a623,color:#333
    style examples fill:#d4edda,stroke:#28a745,color:#333
    style RNG fill:#f5a623,stroke:#333,color:#fff
    style DATA fill:#f5a623,stroke:#333,color:#fff
    style DIRS fill:#f5a623,stroke:#333,color:#fff
```

## 📋 Prerequisites

- [Deno](https://deno.land/) 2.x
- Discovery example only: the NEAT-AI-Discovery Rust library at
  `~/.cargo/lib/libneat_ai_discovery.dylib` (or the appropriate extension for your platform). See
  [discovery/README.md](discovery/README.md#-prerequisites) for build instructions.

## ✅ Quality Check

Run linting, formatting, type checks, unit tests, and every example end-to-end:

```bash
./quality.sh
```

```mermaid
flowchart LR
    LINT["🔎 Lint<br/>deno lint"]
    FMT["✨ Format Check<br/>deno fmt --check"]
    CHECK["🧐 Type Check<br/>deno check"]
    TEST["🧪 Unit Tests<br/>deno test"]
    EX["🚀 Example Runners<br/>run.sh scripts"]
    PASS["✅ All Passed"]
    FAIL["❌ Failed"]

    LINT -->|pass| FMT
    FMT -->|pass| CHECK
    CHECK -->|pass| TEST
    TEST -->|pass| EX
    EX -->|pass| PASS
    LINT -->|fail| FAIL
    FMT -->|fail| FAIL
    CHECK -->|fail| FAIL
    TEST -->|fail| FAIL
    EX -->|fail| FAIL

    style LINT fill:#3498db,stroke:#333,color:#fff
    style FMT fill:#9b59b6,stroke:#333,color:#fff
    style CHECK fill:#f39c12,stroke:#333,color:#fff
    style TEST fill:#e67e22,stroke:#333,color:#fff
    style EX fill:#1abc9c,stroke:#333,color:#fff
    style PASS fill:#2ecc71,stroke:#333,color:#fff
    style FAIL fill:#e74c3c,stroke:#333,color:#fff
```

A GitHub Actions workflow ([`.github/workflows/quality.yml`](.github/workflows/quality.yml)) runs
the same pipeline on every push and pull request to `Develop`. Failing checks block merges.

> [!NOTE]
> The Discovery example needs a native Rust FFI library that is not yet available in CI, so its step
> is allowed to fail gracefully there.

<details>
<summary>🧪 Running tests, lint, fmt, and benchmarks independently</summary>

```bash
# All unit tests
deno test --no-check --allow-read --allow-write --allow-env

# A single test file
deno test --no-check --allow-read --allow-write --allow-env discovery/discover_missing_neuron_test.ts

# Lint, format check, and type check
deno lint
deno fmt --check
deno check **/*.ts

# Benchmarks (run in isolation, not part of quality.sh)
deno bench --allow-read --allow-write --allow-env
deno bench --allow-read --allow-write --allow-env discovery/
```

The formatter (configured in [`deno.json`](deno.json)) uses 2-space indentation, 100-character line
width, and double quotes. See [AGENTS.md](AGENTS.md) for the full testing philosophy and the
unit-tests-vs-benchmarks rules.

</details>

## Related Repositories

The NEAT-AI project is split across seven public repositories. Each focuses on one concern and
composes with the others as shown below.

| Repository                                                             | Role                                                                                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [NEAT-AI](https://github.com/stSoftwareAU/NEAT-AI)                     | Primary Deno/TypeScript neural-network engine (evolution, training, WASM activation).                             |
| [NEAT-AI-core](https://github.com/stSoftwareAU/NEAT-AI-core)           | Shared native Rust library (`neat-core`) with numerics, topology helpers, and the chunked `.bin` training stream. |
| [NEAT-AI-Discovery](https://github.com/stSoftwareAU/NEAT-AI-Discovery) | Rust discovery module invoked by NEAT-AI via Deno FFI to search architectures and hyper-parameters.               |
| [NEAT-AI-Snapshot](https://github.com/stSoftwareAU/NEAT-AI-Snapshot)   | Creature/genome snapshot format and fixtures produced by NEAT-AI and consumed by downstream tools.                |
| [NEAT-AI-scorer](https://github.com/stSoftwareAU/NEAT-AI-scorer)       | Production forward-only scoring application built on `neat-core` via a path dependency.                           |
| [NEAT-AI-Explore](https://github.com/stSoftwareAU/NEAT-AI-Explore)     | Visualiser for creatures that reads NEAT-AI-Snapshot data.                                                        |
| [NEAT-AI-Examples](https://github.com/stSoftwareAU/NEAT-AI-Examples)   | Worked examples and tutorials that depend on NEAT-AI.                                                             |

### Dependency graph

```mermaid
graph TD
    Core[NEAT-AI-core<br/>Rust shared lib]
    Main[NEAT-AI<br/>Deno/TypeScript engine]
    Discovery[NEAT-AI-Discovery<br/>Rust, via Deno FFI]
    Snapshot[NEAT-AI-Snapshot<br/>creature data]
    Scorer[NEAT-AI-scorer<br/>Rust scorer app]
    Explore[NEAT-AI-Explore<br/>visualiser]
    Examples[NEAT-AI-Examples<br/>tutorials]

    Main -->|Deno FFI| Discovery
    Main -->|produces| Snapshot
    Scorer -->|path dependency| Core
    Explore -->|reads| Snapshot
    Examples -->|depends on| Main
```

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, how to add new examples, coding
standards, and the pull request checklist.

## 📄 Licence

Apache Licence 2.0 — see [LICENSE](LICENSE).

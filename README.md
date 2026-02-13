# NEAT-AI-Examples

Companion programs demonstrating how to use [`NEAT-AI`](https://github.com/stSoftwareAU/NEAT-AI).
Each example is self-contained and generates its own synthetic data, so you can run them immediately
without any external dependencies beyond Deno and the NEAT-AI library.

## Prerequisites

- [Deno](https://deno.land/) runtime installed
- For the Discovery example: the NEAT-AI-Discovery Rust library installed at
  `~/.cargo/lib/libneat_ai_discovery.dylib` (or the appropriate extension for your platform)

## Quality Check

Run linting, formatting checks, unit tests, and all examples to verify everything works correctly:

```bash
./quality.sh
```

This script runs:

1. **Linting** — `deno lint` with the recommended rule set configured in `deno.json`.
2. **Formatting** — `deno fmt --check` to enforce consistent style (2-space indent, 100-char line
   width, double quotes).
3. **Unit tests** — `deno test` across the project (tests live next to each module as `*_test.ts`
   files).
4. **Example programs** — each example runner script, verifying the full end-to-end workflow.

### Continuous Integration

A GitHub Actions workflow automatically runs the quality checks on every push and pull request to
the `Develop` branch. The workflow configuration is at `.github/workflows/quality.yml`. Failing
checks will block merges, ensuring all examples remain functional across contributions.

> **Note:** The Discovery example requires a native Rust FFI library that is not yet available in
> CI, so its step is allowed to fail gracefully.

### Running Tests Independently

```bash
# All unit tests
deno test --no-check --allow-read --allow-write --allow-env

# A single test file
deno test --no-check --allow-read --allow-write --allow-env discovery/discover_missing_neuron_test.ts
```

### Linting and Formatting

The project uses `deno lint` (recommended rules) and `deno fmt` for consistent code style. To check
locally:

```bash
# Check for lint issues
deno lint

# Check formatting (no changes)
deno fmt --check

# Auto-fix formatting
deno fmt
```

The formatting configuration (in `deno.json`) uses 2-space indentation, 100-character line width,
and double quotes. All code must pass both lint and format checks before merging.

### Unit Tests vs Benchmarks

- **Unit tests** verify _what_ the code produces (correct outputs, valid structures, expected side
  effects). They never measure timing.
- **Benchmarks** measure _how fast_ the code runs. They use `deno bench` and run in isolation.

Unit tests run in parallel, so timing measurements inside them are unreliable. Keep performance
assertions in benchmarks only. See [AGENTS.md](AGENTS.md) for the full testing guidelines.

## Intelligent Design: Squash Improvement Scan

`intelligent_design/improve_squash_example.ts` demonstrates how to use the Intelligent Design module
to systematically test different activation functions (squashes) for each hidden neuron in a
creature. This technique is used in production workflows to optimise trained models by finding
better squash functions than those produced by random mutation.

### How it works

1. Creates a reference creature with several hidden neurons
2. Generates synthetic training data
3. Scores the baseline creature
4. Scans each hidden neuron, trying the target squash function
5. For neurons that improve, tries alternative squash functions
6. Combines the best improvements into a final creature

### Running the example

```bash
./intelligent_design/run.sh
```

By default, the example tries `GELU` as the target squash. You can specify a different squash:

```bash
./intelligent_design/run.sh Swish
./intelligent_design/run.sh LeakyReLU
```

The script writes all artefacts to `.synthetic-intelligent-design/`, a hidden directory ignored by
git. You will find:

- `data/` – Binary training data for scoring
- `creatures/baseline.json` – The original reference creature
- `creatures/improved.json` – The improved creature (if improvements were found)
- `output/` – Individual improved creatures for each neuron

### Tacit Knowledge

In production workflows, successful squash substitutions are recorded as "tacit knowledge" –
mappings from neuron UUID to squash function. This knowledge can be shared across machines (via a
"hive" file in a git repository) or kept local. When a model is loaded, tacit knowledge is applied
to quickly reapply known-good squash substitutions without rescanning.

## Discovery: Recover a Missing Neuron

`discovery/discover_missing_neuron.ts` demonstrates the neuron discovery workflow. It creates a
simple creature, generates synthetic training data, removes a hidden neuron to "cripple" the
creature, and then runs discovery to attempt to recover the missing functionality.

### How it works

1. Creates a reference creature with 4 inputs, 4 hidden neurons, and 1 output
2. Generates synthetic training data based on the creature's behavior
3. Removes a hidden neuron (LeakyReLU) to create a "crippled" creature
4. Compares baseline and crippled scores to show the performance loss
5. Runs `Creature.discoveryDir()` to search for improvements
6. Reports whether discovery found a way to recover performance

### Prerequisites

- The NEAT-AI-Discovery Rust library must be installed. Build it via `cargo build --release` in the
  NEAT-AI-Discovery repository and copy the resulting library to `~/.cargo/lib/`.
- Deno with FFI permissions enabled

### Running the example

```bash
./discovery/run.sh
```

The script writes all artefacts to `.synthetic-discovery/`, a hidden directory ignored by git. You
will find:

- `data/` – Binary training data containing the synthetic observations
- `creatures/baseline.json` – The untouched reference creature
- `creatures/crippled.json` – The creature with the target neuron removed
- `creatures/discovered.json` – The best candidate returned by discovery (when available)

## Suggest Improvements: Project Analyser

`suggest_improvements/suggest_improvements.ts` analyses the NEAT-AI-Examples project structure and
produces actionable improvement suggestions. These suggestions can be filed as GitHub issues using
the GH CLI.

### How it works

1. Scans the project for common improvement opportunities
2. Categorises suggestions (CI/CD, code quality, documentation, new examples)
3. Produces a structured list with titles, descriptions, and categories
4. Optionally writes a markdown summary to `.synthetic-suggest-improvements/`

### Running the example

```bash
./suggest_improvements/run.sh
```

The output lists each improvement suggestion with its category and description. To file the
suggestions as GitHub issues, use the GH CLI:

```bash
gh issue create --title "Improvement title" --label "enhancement" --body "Description"
```

## License

See [LICENSE](LICENSE) for details.

# Contributing to NEAT-AI-Examples

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

### Deno

Install the [Deno](https://deno.land/) runtime. Version 2.x or later is recommended.

```bash
# macOS / Linux
curl -fsSL https://deno.land/install.sh | sh
```

After installation, ensure `deno` is on your `PATH`:

```bash
deno --version
```

### NEAT-AI-Discovery Rust Library (optional)

The Discovery example requires a native Rust FFI library. Build it from the
[NEAT-AI-Discovery](https://github.com/stSoftwareAU/NEAT-AI-Discovery) repository:

```bash
cargo build --release
```

Then copy the compiled library to `~/.cargo/lib/`:

| Platform | Library file                 | Destination                               |
| -------- | ---------------------------- | ----------------------------------------- |
| macOS    | `libneat_ai_discovery.dylib` | `~/.cargo/lib/libneat_ai_discovery.dylib` |
| Linux    | `libneat_ai_discovery.so`    | `~/.cargo/lib/libneat_ai_discovery.so`    |

> **Note:** The Discovery example is allowed to fail in CI because the Rust library is not yet
> available as a CI artefact. All other examples must pass.

## Development Workflow

### Running the Quality Gate

Before submitting any changes, run the full quality gate:

```bash
./quality.sh
```

This executes, in order:

1. `deno lint` — static analysis with the recommended rule set
2. `deno fmt --check` — formatting verification (2-space indent, 100-char line width, double quotes)
3. `deno test` — all unit tests across the project
4. Each example runner script (`run.sh`) — end-to-end verification

All steps must pass before merging.

### Running Tests Independently

```bash
# All unit tests
deno test --no-check --allow-read --allow-write --allow-env

# A single test file
deno test --no-check --allow-read --allow-write --allow-env crossover/crossover_example_test.ts
```

### Linting and Formatting

```bash
# Check for lint issues
deno lint

# Check formatting without modifying files
deno fmt --check

# Auto-fix formatting
deno fmt
```

## Adding a New Example

Each example follows a consistent three-file pattern. Use these steps to add a new one:

### 1. Create the example directory

```bash
mkdir my_example
```

### 2. Write the example module

Create `my_example/my_example.ts` with the core logic. Import shared utilities from `common/`:

```ts
import { generateSyntheticData, scoreCreature } from "../common/synthetic_data.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
```

### 3. Write unit tests

Create `my_example/my_example_test.ts` next to the module. Tests must be "what" tests — call real
functions with test data and assert on outputs, exit codes, or side effects. See
[Testing Guidelines](#testing-guidelines) below.

### 4. Write the runner script

Create `my_example/run.sh`:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

if ! command -v deno &> /dev/null; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

deno run \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-run \
  my_example/my_example.ts \
  "$@"
```

Make it executable:

```bash
chmod +x my_example/run.sh
```

### 5. Register the example in quality.sh

Add a `run_example` call so the quality gate exercises it:

```bash
run_example "My Example" "./my_example/run.sh"
```

### 6. Update README.md

Add a section describing what the example demonstrates, how it works, and how to run it.

### 7. Verify

Run the full quality gate to confirm everything passes:

```bash
./quality.sh
```

## Testing Guidelines

Every test must be a **"what" test** — it verifies _what_ the code produces, never _how_ it produces
it.

**Good (what tests):**

- Call a function with known input and assert the output value
- Create a creature, activate it, and check that the result is finite
- Generate data files and verify their existence and size
- Remove a neuron and confirm the creature still validates

**Bad (how tests — do not write these):**

- Grep source code for a pattern or function name
- Assert that one function calls another
- Check that a specific algorithm or data structure is used internally

For the full testing philosophy, including unit tests vs benchmarks, see [AGENTS.md](AGENTS.md).

### Test file conventions

- Place test files next to the module they test: `<module>_test.ts`
- Use `Deno.test(...)` with descriptive names
- Import the functions under test directly
- Clean up temporary files in a `finally` block
- Use `Deno.makeTempDirSync()` for any file I/O so tests never pollute the working tree

## Code Style

### Australian English

All code, comments, and documentation **must** use Australian English spelling. Common examples:

| American English | Australian English |
| ---------------- | ------------------ |
| color            | colour             |
| behavior         | behaviour          |
| organization     | organisation       |
| favor            | favour             |
| meter            | metre              |
| center           | centre             |
| optimize         | optimise           |

### Formatting

The project enforces consistent formatting via `deno fmt` with the configuration in `deno.json`:

- 2-space indentation (no tabs)
- 100-character line width
- Double quotes

Run `deno fmt` before committing to auto-fix formatting issues.

## Pull Request Checklist

Before submitting a pull request, verify the following:

- [ ] `./quality.sh` passes — lint, format, tests, and examples all succeed
- [ ] New code has corresponding unit tests (placed next to the module as `*_test.ts`)
- [ ] Australian English spelling is used throughout
- [ ] `README.md` is updated if your change adds or modifies an example
- [ ] Commit messages are clear and reference the relevant issue number
- [ ] The PR targets the `Develop` branch

## Continuous Integration

A GitHub Actions workflow automatically runs the quality checks on every push and pull request to
the `Develop` branch. Failing checks will block merges.

## Getting Help

If you have questions about the project or need guidance, open a GitHub issue or check the existing
documentation:

- [README.md](README.md) — project overview and example descriptions
- [AGENTS.md](AGENTS.md) — detailed coding and testing guidelines

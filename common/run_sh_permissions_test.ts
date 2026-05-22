// Regression tests for issue #419: tighten over-broad Deno permission
// flags in every `*/run.sh` wrapper.
//
// The audit on #410 flagged that every example runner used bare
// `--allow-env` and `--allow-net`, and four (`adaptive_mutation`,
// `crossover`, `neuron_pruning`, `synthetic_synapse`) also used bare
// `--allow-run`. Bare flags grant unrestricted access to the entire
// host environment, every network destination, and any binary on the
// machine. As a public examples repo, readers copy these scripts into
// their own projects, so the over-broad flags propagate.
//
// These are behavioural ("what") tests on the produced run.sh files —
// the runners ARE the security policy, so checking their content is
// checking the policy, not the implementation that built them.

import { assert } from "@std/assert";
import { fromFileUrl } from "@std/path";

const REPO_ROOT = fromFileUrl(new URL("../", import.meta.url));

/** Every per-example `run.sh` shipped in the repo. */
async function listRunners(): Promise<string[]> {
  const runners: string[] = [];
  for await (const entry of Deno.readDir(REPO_ROOT)) {
    if (!entry.isDirectory || entry.name.startsWith(".")) continue;
    const path = `${REPO_ROOT}${entry.name}/run.sh`;
    try {
      const stat = await Deno.stat(path);
      if (stat.isFile) runners.push(path);
    } catch {
      // No run.sh in this directory — skip.
    }
  }
  runners.sort();
  return runners;
}

/** Return permission tokens used by the `deno run` invocation. */
function permissionFlags(script: string): string[] {
  // Strip shell comments before scanning — descriptive comments may
  // mention bare flags by name without granting them.
  const stripped = script
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");
  // Match `--allow-<name>` optionally followed by `=<value>`. Captures
  // tokens up to the first whitespace or backslash continuation.
  const matches = stripped.match(/--allow-[a-z-]+(?:=[^\s\\]+)?/g);
  return matches ?? [];
}

Deno.test("no run.sh uses a bare --allow-run", async () => {
  const runners = await listRunners();
  assert(runners.length > 0, "expected at least one run.sh");
  for (const path of runners) {
    const script = await Deno.readTextFile(path);
    for (const flag of permissionFlags(script)) {
      if (flag === "--allow-run") {
        throw new Error(
          `${path} uses bare --allow-run (grants spawn of any binary); ` +
            `scope it (e.g. --allow-run=df) or drop it entirely`,
        );
      }
    }
  }
});

Deno.test("no run.sh uses a bare --allow-env", async () => {
  const runners = await listRunners();
  for (const path of runners) {
    const script = await Deno.readTextFile(path);
    for (const flag of permissionFlags(script)) {
      if (flag === "--allow-env") {
        throw new Error(
          `${path} uses bare --allow-env (reads every env var, including ` +
            `secrets such as GITHUB_TOKEN); scope it with an allowlist`,
        );
      }
    }
  }
});

Deno.test("no run.sh uses a bare --allow-net", async () => {
  const runners = await listRunners();
  for (const path of runners) {
    const script = await Deno.readTextFile(path);
    for (const flag of permissionFlags(script)) {
      if (flag === "--allow-net") {
        throw new Error(
          `${path} uses bare --allow-net (unrestricted egress); scope it ` +
            `to required hosts or drop it`,
        );
      }
    }
  }
});

Deno.test("mnist runner scopes --allow-net to the dataset host", async () => {
  const script = await Deno.readTextFile(`${REPO_ROOT}mnist_classification/run.sh`);
  const flags = permissionFlags(script);
  const net = flags.find((f) => f.startsWith("--allow-net="));
  assert(
    net !== undefined,
    "mnist_classification/run.sh must use --allow-net=<hosts>; it downloads " +
      "training data from storage.googleapis.com",
  );
  assert(
    net!.includes("storage.googleapis.com"),
    `mnist --allow-net must include storage.googleapis.com (got ${net})`,
  );
});

Deno.test("stock-market runner scopes --allow-net to the dataset host", async () => {
  const script = await Deno.readTextFile(`${REPO_ROOT}stock_market/run.sh`);
  const flags = permissionFlags(script);
  const net = flags.find((f) => f.startsWith("--allow-net="));
  assert(
    net !== undefined,
    "stock_market/run.sh must use --allow-net=<hosts>; it downloads the " +
      "S&P 500 dataset from raw.githubusercontent.com",
  );
  assert(
    net!.includes("raw.githubusercontent.com"),
    `stock --allow-net must include raw.githubusercontent.com (got ${net})`,
  );
});

Deno.test("every run.sh allows jsr.io for the NEAT-AI WASM fetch", async () => {
  // @stsoftware/neat-ai fetches its WASM activation payload from jsr.io
  // at runtime (WasmActivationPayload.ts in the JSR package), so every
  // runner must whitelist jsr.io in --allow-net.
  const runners = await listRunners();
  for (const path of runners) {
    const script = await Deno.readTextFile(path);
    const net = permissionFlags(script).find((f) => f.startsWith("--allow-net="));
    assert(
      net !== undefined,
      `${path} must include --allow-net=jsr.io (NEAT-AI fetches its WASM ` +
        `payload from jsr.io at runtime)`,
    );
    assert(
      net!.includes("jsr.io"),
      `${path} --allow-net must include jsr.io (got ${net})`,
    );
  }
});

Deno.test("every run.sh sources the shared example runner preamble", async () => {
  const runners = await listRunners();
  for (const path of runners) {
    const script = await Deno.readTextFile(path);
    assert(
      script.includes('source "${REPO_ROOT}/common/example_runner_preamble.sh"'),
      `${path} must source common/example_runner_preamble.sh (Discovery, rust scorer, Deno flags)`,
    );
    assert(
      script.includes('"${NEAT_EXAMPLE_DENO_FLAGS[@]}"'),
      `${path} must use NEAT_EXAMPLE_DENO_FLAGS from the shared preamble`,
    );
  }
});

Deno.test("example runner preamble grants required Deno flags", async () => {
  const preamble = await Deno.readTextFile(
    `${REPO_ROOT}common/example_runner_preamble.sh`,
  );
  const required = [
    "--no-prompt",
    "--unstable-worker-options",
    "--allow-import",
    "--allow-ffi",
    "--allow-sys=systemMemoryInfo,hostname",
  ];
  for (const flag of required) {
    assert(
      preamble.includes(flag),
      `common/example_runner_preamble.sh must include ${flag}`,
    );
  }
  assert(
    preamble.includes("NEAT_AI_RUST_SCORER_ENABLED"),
    "preamble NEAT_AI_ENV_VARS must allowlist NEAT_AI_RUST_SCORER_ENABLED",
  );
  assert(
    preamble.includes("NEAT_AI_RUST_SCORER_BINARY_PATH"),
    "preamble NEAT_AI_ENV_VARS must allowlist NEAT_AI_RUST_SCORER_BINARY_PATH",
  );
});

Deno.test("every run.sh that loads Discovery uses shared Deno flags with --allow-ffi", async () => {
  const preamble = await Deno.readTextFile(
    `${REPO_ROOT}common/example_runner_preamble.sh`,
  );
  assert(
    preamble.includes("--allow-ffi"),
    "common/example_runner_preamble.sh must pass --allow-ffi for Rust Discovery",
  );
  const runners = await listRunners();
  for (const path of runners) {
    const script = await Deno.readTextFile(path);
    assert(
      script.includes("example_runner_preamble.sh"),
      `${path} must source the shared preamble (includes --allow-ffi for Discovery)`,
    );
  }
});

Deno.test("--allow-env allowlists exclude obvious secret-bearing names", async () => {
  // If a runner ever lists a known secret-bearing env var by accident
  // (e.g. GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY), the allowlist exists
  // for compliance but defeats the point of the issue. Fail loudly.
  const forbidden = [
    "GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_ACCESS_KEY_ID",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ];
  const runners = await listRunners();
  for (const path of runners) {
    const script = await Deno.readTextFile(path);
    const env = permissionFlags(script).find((f) => f.startsWith("--allow-env="));
    if (env === undefined) continue;
    const values = env.slice("--allow-env=".length).split(",");
    for (const v of values) {
      if (forbidden.includes(v)) {
        throw new Error(
          `${path} --allow-env allowlist contains secret-bearing var ${v}`,
        );
      }
    }
  }
});

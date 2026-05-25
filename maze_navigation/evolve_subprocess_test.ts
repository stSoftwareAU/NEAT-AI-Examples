/**
 * Subprocess isolation test for maze evolution.
 *
 * Spawns a fresh Deno subprocess so parallel evolveRL tests cannot
 * pollute NEAT-AI global WASM caches. Asserts only on observable shape
 * of the result — evolution is stochastic and must not be pinned to
 * exact scores or bit-identical reruns.
 */
import { assert, assertEquals, assertGreater, assertGreaterOrEqual } from "@std/assert";
import { join } from "@std/path";
import {
  DEFAULT_EVOLVE_OPTIONS,
  MAX_STEPS,
  SOLVED_THRESHOLD,
  type EvolveResult,
} from "./maze_navigation.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const ONCE_SCRIPT = join(REPO_ROOT, "maze_navigation/evolve_once_cli.ts");

type EvolveSnapshot = Pick<
  EvolveResult,
  "bestScore" | "championReached" | "championSteps" | "championFinalDistance"
>;

async function evolveOnceInFreshProcess(
  options: Record<string, unknown>,
): Promise<EvolveSnapshot> {
  const cmd = new Deno.Command(Deno.execPath(), {
    cwd: REPO_ROOT,
    args: [
      "run",
      "--no-check",
      "--v8-flags=--max-old-space-size=8192",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      "--allow-ffi",
      ONCE_SCRIPT,
      JSON.stringify(options),
    ],
    stdout: "piped",
    stderr: "inherit",
  });
  const { code, stdout } = await cmd.output();
  if (code !== 0) {
    throw new Error(`evolve_once_cli.ts exited with code ${code}`);
  }
  const lines = new TextDecoder().decode(stdout).trim().split("\n").filter((line) =>
    line.length > 0
  );
  const jsonLine = lines.at(-1);
  if (jsonLine === undefined) {
    throw new Error("evolve_once_cli.ts produced no stdout");
  }
  return JSON.parse(jsonLine) as EvolveSnapshot;
}

function assertValidEvolveSnapshot(snapshot: EvolveSnapshot): void {
  assert(Number.isFinite(snapshot.bestScore), `expected finite bestScore, got ${snapshot.bestScore}`);
  assertGreaterOrEqual(snapshot.championSteps, 1);
  assertGreaterOrEqual(snapshot.championFinalDistance, 0);
  assert(snapshot.championSteps <= MAX_STEPS);
  if (snapshot.championReached) {
    assertEquals(snapshot.championFinalDistance, 0);
    assertGreaterOrEqual(snapshot.bestScore, SOLVED_THRESHOLD);
  }
}

Deno.test({
  name: "evolveMazeController subprocess run returns finite champion metrics",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const experimentStore = await Deno.makeTempDir({ prefix: "maze_isolated_" });
    try {
      const snapshot = await evolveOnceInFreshProcess({
        ...DEFAULT_EVOLVE_OPTIONS,
        iterations: 3,
        timeoutMinutes: 1,
        experimentStore,
      });
      assertValidEvolveSnapshot(snapshot);
    } finally {
      await Deno.remove(experimentStore, { recursive: true }).catch(() => {
        // Tolerable — temp dir cleanup is best-effort.
      });
    }
  },
});

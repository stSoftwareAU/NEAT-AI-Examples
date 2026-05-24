/**
 * Isolated reproducibility test for maze evolution.
 *
 * Spawns a fresh Deno subprocess so parallel evolveRL tests in the suite
 * cannot pollute NEAT-AI global WASM caches. Each run also receives a
 * unique temporary directory as `experimentStore` so NEAT-AI cannot read
 * creatures written by prior parallel runs — without this, the subprocess
 * inherits the shared experiment store populated by other tests and finds
 * a "previous experiment" that gives it a head start, diverging from the
 * clean-state golden snapshot.
 */
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DEFAULT_EVOLVE_OPTIONS, type EvolveResult } from "./maze_navigation.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const ONCE_SCRIPT = join(REPO_ROOT, "maze_navigation/evolve_once_cli.ts");

type EvolveSnapshot = Pick<
  EvolveResult,
  "bestScore" | "championReached" | "championSteps" | "championFinalDistance"
>;

/** Golden snapshot for {@link DEFAULT_EVOLVE_OPTIONS} + `iterations: 3` on NEAT-AI 5.0.39. */
const GOLDEN_SNAPSHOT: EvolveSnapshot = {
  bestScore: -0.1473684210526316,
  championReached: false,
  championSteps: 200,
  championFinalDistance: 18,
};

async function evolveOnceInFreshProcess(
  options: Record<string, unknown>,
): Promise<EvolveSnapshot> {
  const cmd = new Deno.Command(Deno.execPath(), {
    cwd: REPO_ROOT,
    args: [
      "run",
      "--no-check",
      // Match the parent test runner's heap budget so the subprocess's
      // MemoryMonitor does not fire and evict WASM activation caches
      // mid-run — cache evictions change which creatures are recompiled
      // vs cached and break the determinism guarantee.
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

Deno.test({
  name: "evolveMazeController is reproducible — fixed seed produces matching champions",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Use a fresh isolated experimentStore so this subprocess cannot read
    // creatures written by other parallel evolveRL tests. Without isolation,
    // NEAT-AI finds a "previous experiment" and achieves a better result
    // than the clean-state golden snapshot.
    const experimentStore = await Deno.makeTempDir({
      prefix: "maze_repro_",
    });
    try {
      const fixedOptions = {
        ...DEFAULT_EVOLVE_OPTIONS,
        iterations: 3,
        timeoutMinutes: 1, // must be >= 1; `iterations` fires first
        experimentStore,
      };
      const snapshot = await evolveOnceInFreshProcess(fixedOptions);
      assertEquals(snapshot, GOLDEN_SNAPSHOT);
    } finally {
      await Deno.remove(experimentStore, { recursive: true }).catch(() => {
        // Tolerable — temp dir cleanup is best-effort.
      });
    }
  },
});

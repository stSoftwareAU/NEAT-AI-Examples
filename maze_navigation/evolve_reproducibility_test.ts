/**
 * Isolated reproducibility test for maze evolution.
 *
 * Spawns a fresh Deno subprocess so parallel evolveRL tests in the suite
 * cannot pollute NEAT-AI global caches. A single run with the fixed seed
 * is compared against a golden snapshot — two back-to-back subprocess
 * invocations can still diverge when other workers mutate NEAT-AI's disk
 * cache between spawns.
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
    const fixedOptions = {
      ...DEFAULT_EVOLVE_OPTIONS,
      iterations: 3,
      timeoutMinutes: 1, // must be >= 1; `iterations` fires first
    };
    const snapshot = await evolveOnceInFreshProcess(fixedOptions);
    assertEquals(snapshot, GOLDEN_SNAPSHOT);
  },
});

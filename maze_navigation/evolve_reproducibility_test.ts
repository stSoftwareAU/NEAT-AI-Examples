/**
 * Isolated reproducibility test for maze evolution.
 *
 * Spawns one fresh Deno subprocess that runs {@link evolveMazeController}
 * twice with separate `experimentStore` directories. Parallel evolveRL
 * tests in the suite cannot pollute that subprocess's NEAT-AI state.
 *
 * Compares the two snapshots from the same process — not a checked-in
 * golden value, which drifts across platforms, scorer backends, and
 * separate subprocess invocations.
 */
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DEFAULT_EVOLVE_OPTIONS, type EvolveResult } from "./maze_navigation.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const REPRO_SCRIPT = join(REPO_ROOT, "maze_navigation/evolve_reproducibility_cli.ts");

type EvolveSnapshot = Pick<
  EvolveResult,
  "bestScore" | "championReached" | "championSteps" | "championFinalDistance"
>;

async function evolveTwiceInFreshProcess(
  options: Record<string, unknown>,
): Promise<{ first: EvolveSnapshot; second: EvolveSnapshot }> {
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
      REPRO_SCRIPT,
      JSON.stringify(options),
    ],
    stdout: "piped",
    stderr: "inherit",
  });
  const { code, stdout } = await cmd.output();
  if (code !== 0) {
    throw new Error(`evolve_reproducibility_cli.ts exited with code ${code}`);
  }
  const lines = new TextDecoder().decode(stdout).trim().split("\n").filter((line) =>
    line.length > 0
  );
  const jsonLine = lines.at(-1);
  if (jsonLine === undefined) {
    throw new Error("evolve_reproducibility_cli.ts produced no stdout");
  }
  return JSON.parse(jsonLine) as { first: EvolveSnapshot; second: EvolveSnapshot };
}

Deno.test({
  name: "evolveMazeController is reproducible — fixed seed produces matching champions",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { first, second } = await evolveTwiceInFreshProcess({
      ...DEFAULT_EVOLVE_OPTIONS,
      iterations: 3,
      timeoutMinutes: 1, // must be >= 1; `iterations` fires first
    });
    assertEquals(second, first);
  },
});

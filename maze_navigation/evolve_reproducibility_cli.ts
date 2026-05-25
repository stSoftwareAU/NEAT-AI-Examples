/**
 * Dual-run maze evolution CLI for the reproducibility test.
 *
 * Runs {@link evolveMazeController} twice in one process with separate
 * `experimentStore` directories and prints both snapshots as JSON.
 * Keeps comparison in-process so WASM / scorer state is identical —
 * separate Deno subprocesses were not bitwise reproducible on macOS CI.
 */
import { evolveMazeController, type EvolveOptions } from "./maze_navigation.ts";

if (Deno.args.length < 1) {
  throw new Error("usage: deno run evolve_reproducibility_cli.ts '<EvolveOptions JSON>'");
}

const baseOptions = JSON.parse(Deno.args[0]) as EvolveOptions;

function snapshot(result: Awaited<ReturnType<typeof evolveMazeController>>) {
  return {
    bestScore: result.bestScore,
    championReached: result.championReached,
    championSteps: result.championSteps,
    championFinalDistance: result.championFinalDistance,
  };
}

const firstStore = await Deno.makeTempDir({ prefix: "maze_repro_a_" });
const secondStore = await Deno.makeTempDir({ prefix: "maze_repro_b_" });
try {
  const first = await evolveMazeController({
    ...baseOptions,
    experimentStore: firstStore,
  });
  const second = await evolveMazeController({
    ...baseOptions,
    experimentStore: secondStore,
  });
  console.log(JSON.stringify({
    first: snapshot(first),
    second: snapshot(second),
  }));
} finally {
  await Deno.remove(firstStore, { recursive: true }).catch(() => {});
  await Deno.remove(secondStore, { recursive: true }).catch(() => {});
}

/**
 * One-shot maze evolution CLI for subprocess isolation tests.
 *
 * Invoked in a fresh Deno process so NEAT-AI global WASM/cache state
 * from other parallel tests cannot leak into the run. The filename
 * deliberately avoids the `*_test.ts` suffix so `deno test` does not
 * execute it as a test module.
 */
import { evolveMazeController, type EvolveOptions } from "./maze_navigation.ts";

if (Deno.args.length < 1) {
  throw new Error("usage: deno run evolve_once_cli.ts '<EvolveOptions JSON>'");
}

const options = JSON.parse(Deno.args[0]) as EvolveOptions;
const result = await evolveMazeController(options);
console.log(
  JSON.stringify({
    bestScore: result.bestScore,
    championReached: result.championReached,
    championSteps: result.championSteps,
    championFinalDistance: result.championFinalDistance,
  }),
);

/**
 * One-shot maze evolution CLI for the reproducibility test.
 *
 * Invoked in a fresh Deno process so NEAT-AI global WASM/cache state
 * from other parallel tests cannot leak into the run.
 */
import { evolveMazeController, type EvolveOptions } from "./maze_navigation.ts";

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

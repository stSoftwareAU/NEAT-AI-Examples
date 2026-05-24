/**
 * Isolated reproducibility test for maze evolution.
 *
 * Kept in its own file so `deno test` runs it in a separate worker.
 * When this lived in `maze_navigation_test.ts`, concurrent evolveRL
 * tests in the same file polluted NEAT-AI global caches and made
 * back-to-back runs with the same seed diverge.
 */
import { assertEquals } from "@std/assert";
import {
  DEFAULT_EVOLVE_OPTIONS,
  evolveMazeController,
} from "./maze_navigation.ts";

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
    const a = await evolveMazeController(fixedOptions);
    const b = await evolveMazeController(fixedOptions);
    assertEquals(a.bestScore, b.bestScore);
    assertEquals(a.championReached, b.championReached);
    assertEquals(a.championSteps, b.championSteps);
    assertEquals(a.championFinalDistance, b.championFinalDistance);
  },
});

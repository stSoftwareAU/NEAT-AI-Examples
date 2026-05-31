/**
 * Unit tests for the shared {@link runEpisode} rollout helper.
 *
 * These are "what" tests — they drive `runEpisode` against a tiny
 * synthetic simulator (a 1-D walker) and assert on the returned trace,
 * final state, and step count. No real game required.
 */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { createSeededRng, Creature, setRandomNumberGenerator } from "@stsoftware/neat-ai";

import { type EpisodeAdapter, runEpisode } from "./episode_runner.ts";

/**
 * Construct a deterministic 1-input/1-output Creature. The activation
 * outputs are irrelevant for these tests because every adapter ignores
 * them and returns a fixed action — what we are exercising is the loop
 * shape, not the controller.
 */
function tinyCreature(): Creature {
  setRandomNumberGenerator(createSeededRng(1));
  return new Creature(1, 1);
}

/** 1-D walker: state is a position; action is a `+1`/`-1` step. */
type WalkerAdapter = EpisodeAdapter<number, 1 | -1>;

function makeWalker(
  initialState: number,
  isTerminal: (s: number) => boolean,
  action: 1 | -1 = 1,
): WalkerAdapter {
  return {
    initialState,
    encode: (s) => new Float32Array([s]),
    decode: () => action,
    step: (s, a) => s + a,
    isTerminal,
  };
}

Deno.test("runEpisode — happy path: walks until isTerminal fires", () => {
  const creature = tinyCreature();
  const adapter = makeWalker(0, (s) => s >= 5);

  const result = runEpisode(creature, adapter, { maxSteps: 100 });

  assertEquals(result.steps, 5, "five steps reached state 5");
  assertEquals(result.finalState, 5);
  assertEquals(result.trace, [0, 1, 2, 3, 4, 5]);
  assertEquals(
    result.trace.length,
    result.steps + 1,
    "trace includes initial state plus one entry per step",
  );
});

Deno.test("runEpisode — early termination on first step", () => {
  const creature = tinyCreature();
  const adapter = makeWalker(0, (s) => s >= 1);

  const result = runEpisode(creature, adapter, { maxSteps: 10 });

  assertEquals(result.steps, 1, "isTerminal fired immediately after step 1");
  assertEquals(result.finalState, 1);
  assertEquals(result.trace, [0, 1]);
});

Deno.test("runEpisode — caps at maxSteps when isTerminal never fires", () => {
  const creature = tinyCreature();
  const adapter = makeWalker(0, () => false);

  const result = runEpisode(creature, adapter, { maxSteps: 3 });

  assertEquals(result.steps, 3, "loop ran exactly maxSteps ticks");
  assertEquals(result.finalState, 3);
  assertEquals(result.trace, [0, 1, 2, 3]);
});

Deno.test("runEpisode — maxSteps=0 returns initial state untouched", () => {
  const creature = tinyCreature();
  const adapter = makeWalker(7, () => false);

  const result = runEpisode(creature, adapter, { maxSteps: 0 });

  assertEquals(result.steps, 0);
  assertEquals(result.finalState, 7);
  assertEquals(result.trace, [7]);
});

/**
 * Build a minimal stub Creature with a single recurrent accumulator.
 * `clearState()` resets the accumulator to zero; each `activate()` call
 * increments it and returns the running total as the activation output.
 *
 * This lets the `clearStatePerTick` tests assert on an *observable*
 * outcome — the episode trace — instead of counting internal
 * `clearState` calls. When state is cleared every tick the accumulator
 * never grows, so the output is a constant `1`; when state carries over,
 * the output climbs `1, 2, 3, …` and the trace visibly diverges.
 */
function recurrentStub(): Creature {
  let acc = 0;
  const stub = {
    clearState: () => {
      acc = 0;
    },
    activate: (_input: Float32Array): Float32Array => {
      acc += 1;
      return new Float32Array([acc]);
    },
  };
  return stub as unknown as Creature;
}

/**
 * Walker whose per-tick step delta IS the creature's output, so any
 * carry-over in recurrent state shows up directly in the trace.
 */
const accumulatingWalker: EpisodeAdapter<number, number> = {
  initialState: 0,
  encode: (s) => new Float32Array([s]),
  decode: (out) => out[0],
  step: (s, a) => s + a,
  isTerminal: () => false,
};

Deno.test("runEpisode — clears recurrent state per tick by default (observable via trace)", () => {
  // Default behaviour: state reset before every activation, so the
  // accumulator output is a constant 1 and each tick advances by +1.
  const defaultTrace = runEpisode(recurrentStub(), accumulatingWalker, { maxSteps: 4 }).trace;
  const explicitTrace = runEpisode(recurrentStub(), accumulatingWalker, {
    maxSteps: 4,
    clearStatePerTick: true,
  }).trace;

  assertEquals(defaultTrace, [0, 1, 2, 3, 4]);
  assertEquals(
    defaultTrace,
    explicitTrace,
    "omitting the flag matches clearStatePerTick: true",
  );
});

Deno.test("runEpisode — clearStatePerTick=false retains recurrent state across ticks", () => {
  // State carries over, so the accumulator output climbs 1, 2, 3, 4 and
  // the walker accelerates: 0 → 1 → 3 → 6 → 10.
  const result = runEpisode(recurrentStub(), accumulatingWalker, {
    maxSteps: 4,
    clearStatePerTick: false,
  });

  assertEquals(result.steps, 4);
  assertEquals(result.trace, [0, 1, 3, 6, 10]);
  assertEquals(result.finalState, 10);
});

Deno.test("runEpisode — clearStatePerTick toggles the observable episode trace", () => {
  const onTrace = runEpisode(recurrentStub(), accumulatingWalker, {
    maxSteps: 4,
    clearStatePerTick: true,
  }).trace;
  const offTrace = runEpisode(recurrentStub(), accumulatingWalker, {
    maxSteps: 4,
    clearStatePerTick: false,
  }).trace;

  // The flag has a real, caller-visible effect — not just an internal
  // call-count difference.
  assertNotEquals(onTrace, offTrace);
});

Deno.test("runEpisode — adapter.encode receives the current state", () => {
  const creature = tinyCreature();
  const seenStates: number[] = [];
  const adapter: WalkerAdapter = {
    initialState: 0,
    encode: (s) => {
      seenStates.push(s);
      return new Float32Array([s]);
    },
    decode: () => 1,
    step: (s, a) => s + a,
    isTerminal: (s) => s >= 3,
  };

  runEpisode(creature, adapter, { maxSteps: 10 });

  // encode is called once per executed tick on the pre-step state.
  assertEquals(seenStates, [0, 1, 2]);
});

Deno.test("runEpisode — adapter.decode receives the activation output", () => {
  const creature = tinyCreature();
  let outputSeen: Float32Array | null = null;
  const adapter: WalkerAdapter = {
    initialState: 0,
    encode: (s) => new Float32Array([s]),
    decode: (out) => {
      outputSeen = out;
      return 1;
    },
    step: (s, a) => s + a,
    isTerminal: (s) => s >= 1,
  };

  runEpisode(creature, adapter, { maxSteps: 10 });

  assert(outputSeen !== null, "decode must receive the activation output");
  assertEquals((outputSeen as unknown as Float32Array).length, 1);
});

Deno.test("runEpisode — works with custom state objects", () => {
  interface Pos {
    x: number;
    y: number;
  }
  setRandomNumberGenerator(createSeededRng(1));
  const creature = new Creature(2, 1);
  const adapter: EpisodeAdapter<Pos, "right"> = {
    initialState: { x: 0, y: 0 },
    encode: (s) => new Float32Array([s.x, s.y]),
    decode: () => "right",
    step: (s) => ({ x: s.x + 1, y: s.y }),
    isTerminal: (s) => s.x >= 2,
  };

  const result = runEpisode(creature, adapter, { maxSteps: 5 });

  assertEquals(result.steps, 2);
  assertEquals(result.finalState, { x: 2, y: 0 });
  assertEquals(result.trace.length, 3);
});

/**
 * Shared episode-rollout helper for NEAT-AI agent examples.
 *
 * Every agent example (`cart_pole`, `snake_game`, `mountain_car`,
 * `lunar_lander`, `maze_navigation`, …) reimplements the same loop:
 *
 *   for (let i = 0; i < maxSteps; i++) {
 *     creature.clearState();
 *     const out = creature.activate(encode(state));
 *     state = step(state, decode(out));
 *     if (terminal(state)) break;
 *   }
 *
 * `runEpisode` gives that pattern a single named home so newcomers can
 * read it once and so the examples cannot drift out of sync.
 *
 * The helper is deliberately tiny: it handles the loop body only. Each
 * caller still owns reward shaping, multi-trial averaging, snapshotting,
 * and any other example-specific logic. Pass an {@link EpisodeAdapter}
 * describing how to encode observations, decode actions, advance the
 * simulator, and detect terminal states; receive back the trace, the
 * final state, and the number of steps actually executed.
 */
import type { Creature } from "@stsoftware/neat-ai";

/**
 * Adapter describing how to drive a simulator with state type `S` and
 * action type `A` from a {@link Creature}'s outputs.
 */
export interface EpisodeAdapter<S, A> {
  /** Initial simulator state for this episode. */
  initialState: S;
  /** Encode the current state as a Float32Array for `creature.activate`. */
  encode(state: S): Float32Array;
  /** Decode the activation outputs (and current state) into an action. */
  decode(output: Float32Array, state: S): A;
  /** Advance the simulator by one tick and return the new state. */
  step(state: S, action: A): S;
  /** True when `state` is terminal (collision, success, timeout, …). */
  isTerminal(state: S): boolean;
}

/** Options controlling rollout behaviour. */
export interface EpisodeOptions {
  /** Hard cap on the number of ticks before the loop exits. */
  maxSteps: number;
  /**
   * When `true` (the default) `creature.clearState()` is called before
   * every activation — matches the existing example behaviour. Pass
   * `false` to keep recurrent state between ticks.
   */
  clearStatePerTick?: boolean;
}

/** Outcome of a single rollout. */
export interface EpisodeResult<S> {
  /**
   * State trace including the initial state and the post-step state of
   * every executed tick (so `trace.length === steps + 1`). The terminal
   * state, if any, is included as the final entry.
   */
  trace: S[];
  /** Final state when the episode ended. */
  finalState: S;
  /**
   * Number of simulator steps actually executed. Equals `maxSteps` when
   * the loop ran to completion, otherwise the index of the terminal
   * step (1-based — the failing step counts as executed).
   */
  steps: number;
}

/**
 * Run a single rollout of `creature` against `adapter`. Pure loop body —
 * no scoring, no shaping, no I/O.
 */
export function runEpisode<S, A>(
  creature: Creature,
  adapter: EpisodeAdapter<S, A>,
  opts: EpisodeOptions,
): EpisodeResult<S> {
  const clearState = opts.clearStatePerTick !== false;
  let state: S = adapter.initialState;
  const trace: S[] = [state];
  let steps = 0;
  for (let i = 0; i < opts.maxSteps; i++) {
    if (clearState) creature.clearState();
    const out = creature.activate(adapter.encode(state));
    const action = adapter.decode(out, state);
    state = adapter.step(state, action);
    trace.push(state);
    steps++;
    if (adapter.isTerminal(state)) break;
  }
  return { trace, finalState: state, steps };
}

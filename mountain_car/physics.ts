/**
 * Deterministic Mountain-Car physics.
 *
 * A pure-TypeScript port of the canonical `MountainCar-v0` benchmark
 * from OpenAI Gym: an under-powered car sits in a sinusoidal valley
 * between two hills and must reach the goal flag at the top of the
 * right-hand hill. The car's engine is too weak to drive directly up
 * the slope, so the controller has to learn to swing back-and-forth
 * across the valley to build momentum.
 *
 * Coordinate system:
 *   - `x`: horizontal position along the hill profile (dimensionless,
 *     bounded `[-1.2, 0.6]`). The valley floor is near `x = -0.5236`
 *     (`-π/6`); the goal flag is at `x ≥ 0.5`.
 *   - `v`: horizontal velocity (bounded `[-0.07, 0.07]`).
 *
 * Update rules (matching the Gym reference):
 *   - `v ← clamp(v + 0.001·a − 0.0025·cos(3·x), -0.07, +0.07)`
 *   - `x ← clamp(x + v, -1.2, +0.6)`
 *   - Hitting the left wall (`x = -1.2`) sets `v = 0`.
 *
 * Pure functions only — no global state, no hidden timers — so
 * simulations are reproducible across runs and platforms.
 */

/** Immutable Mountain-Car state vector. */
export interface MountainCarState {
  /** Horizontal position along the hill profile, bounded `[-1.2, 0.6]`. */
  x: number;
  /** Horizontal velocity, bounded `[-0.07, 0.07]`. */
  v: number;
}

/** Physical parameters governing the Mountain-Car dynamics. */
export interface MountainCarParams {
  /** Engine acceleration coefficient (per `step` action unit). */
  engineAccel: number;
  /** Gravity coefficient acting through the `cos(3·x)` slope term. */
  gravity: number;
  /** Minimum allowed position (left wall). */
  minPosition: number;
  /** Maximum allowed position (right wall, beyond the goal). */
  maxPosition: number;
  /** Maximum absolute velocity. */
  maxSpeed: number;
}

/** Default physical parameters — match the OpenAI Gym reference. */
export const DEFAULT_PARAMS: MountainCarParams = {
  engineAccel: 0.001,
  gravity: 0.0025,
  minPosition: -1.2,
  maxPosition: 0.6,
  maxSpeed: 0.07,
};

/**
 * Goal threshold: an episode is "solved" the first time the car's
 * position reaches or exceeds this value.
 */
export const GOAL_POSITION = 0.5;

/** Default starting position — the deterministic centre of the valley. */
export const DEFAULT_START_X = -0.5;

/** Default starting velocity. */
export const DEFAULT_START_V = 0;

/** Maximum number of timesteps the canonical `MountainCar-v0` allows. */
export const MAX_EPISODE_STEPS = 200;

/** Build the canonical initial state: at rest at the valley centre. */
export function initialState(
  overrides: Partial<MountainCarState> = {},
): MountainCarState {
  return { x: DEFAULT_START_X, v: DEFAULT_START_V, ...overrides };
}

/**
 * Initial state perturbed around the valley centre. The position is
 * sampled uniformly from `[DEFAULT_START_X - magnitude,
 * DEFAULT_START_X + magnitude]` (clamped to the track), and the
 * starting velocity stays at zero — matching the canonical OpenAI Gym
 * `MountainCar-v0` reset, which always starts the car at rest but
 * varies its position. A controller cannot solve every perturbed
 * launch by exploiting the perfectly symmetric `(-0.5, 0)` start.
 *
 * @param random Deterministic PRNG returning values in `[0, 1)`.
 * @param magnitude Half-width of the position-sampling window. The
 *                  default `0.05` keeps every start inside the valley
 *                  bowl so the swing-up problem stays well posed.
 */
export function perturbedInitialState(
  random: () => number,
  magnitude: number = 0.05,
  params: MountainCarParams = DEFAULT_PARAMS,
): MountainCarState {
  const offset = (random() * 2 - 1) * magnitude;
  const x = Math.min(
    Math.max(DEFAULT_START_X + offset, params.minPosition),
    params.maxPosition,
  );
  return { x, v: DEFAULT_START_V };
}

/** Clamp a value to the closed interval `[lo, hi]`. */
function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/** Normalise the action to `{-1, 0, +1}`. Any non-finite value maps to 0. */
function normaliseAction(action: number): -1 | 0 | 1 {
  if (!Number.isFinite(action)) return 0;
  if (action > 0) return 1;
  if (action < 0) return -1;
  return 0;
}

/**
 * Advance the Mountain-Car simulation by one time step.
 *
 * Velocity is updated first (engine push minus gravity along the
 * sinusoidal slope) then clamped, then position is updated and clamped.
 * Hitting the left wall (`x = minPosition`) zeroes the velocity, as in
 * the OpenAI Gym reference implementation.
 *
 * @param state Current state.
 * @param action Direction of the engine push: `-1` left, `0` coast,
 *               `+1` right. Any non-zero numeric value is normalised
 *               by sign.
 * @param params Physical parameters (defaults to {@link DEFAULT_PARAMS}).
 * @returns The state after one time step. The input state is not mutated.
 */
export function step(
  state: MountainCarState,
  action: number,
  params: MountainCarParams = DEFAULT_PARAMS,
): MountainCarState {
  const a = normaliseAction(action);

  let v = state.v + a * params.engineAccel - params.gravity * Math.cos(3 * state.x);
  v = clamp(v, -params.maxSpeed, params.maxSpeed);

  let x = state.x + v;
  x = clamp(x, params.minPosition, params.maxPosition);

  // Hitting the left wall absorbs all kinetic energy.
  if (x === params.minPosition && v < 0) {
    v = 0;
  }

  return { x, v };
}

/**
 * Returns true when the car has reached the goal flag — the only
 * success condition for `MountainCar-v0`.
 */
export function isSuccess(
  state: MountainCarState,
  goal: number = GOAL_POSITION,
): boolean {
  return state.x >= goal;
}

/**
 * Encode a {@link MountainCarState} as a Float32Array suitable for
 * feeding to a NEAT-AI creature: `[x, v]`.
 */
export function encodeState(state: MountainCarState): Float32Array {
  return new Float32Array([state.x, state.v]);
}

/**
 * The vertical height (dimensionless) of the hill at horizontal
 * position `x`. The classic OpenAI Gym profile is `sin(3·x) · 0.45 + 0.55`
 * which maps `x ∈ [-1.2, 0.6]` onto a smooth valley with a peak at the
 * goal flag. Used by the SVG renderer; included here so consumers do
 * not have to reimplement the formula.
 */
export function hillHeight(x: number): number {
  return Math.sin(3 * x) * 0.45 + 0.55;
}

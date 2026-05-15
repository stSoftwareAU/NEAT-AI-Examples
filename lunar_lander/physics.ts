/**
 * Deterministic 2D lunar-lander physics.
 *
 * A simplified model of the classic Lunar Lander control task. The
 * lander is a rigid body with translational and rotational degrees of
 * freedom, controlled by three discrete thrusters: a main engine that
 * accelerates the lander along its local "up" axis, plus left and right
 * RCS thrusters that apply pure torque. Gravity acts downwards. Each
 * call to {@link step} advances the simulation by one fixed time step
 * using semi-implicit Euler integration.
 *
 * Coordinate system:
 *   - `x`: horizontal position (metres). Positive = right, 0 above the pad centre.
 *   - `y`: altitude (metres). Positive = up, 0 at ground level.
 *   - `vx`, `vy`: velocity components (metres per second).
 *   - `angle`: rotation about the lander's centre (radians). 0 = upright;
 *     positive tilts left (anti-clockwise in screen coordinates).
 *   - `angularV`: angular velocity (radians per second).
 *   - `fuel`: remaining propellant (arbitrary units). The lander cannot
 *     fire any thruster once fuel reaches zero.
 *
 * The whole module is composed of pure functions — no global state, no
 * hidden timers — so simulations are reproducible across runs.
 */

/** Immutable lander state vector. */
export interface LanderState {
  /** Horizontal position (metres). */
  x: number;
  /** Altitude (metres). */
  y: number;
  /** Horizontal velocity (m/s). */
  vx: number;
  /** Vertical velocity (m/s). Negative = falling. */
  vy: number;
  /** Tilt from upright (radians). Positive = leaning left. */
  angle: number;
  /** Angular velocity (rad/s). */
  angularV: number;
  /** Remaining fuel (arbitrary units, never negative). */
  fuel: number;
}

/** Discrete thruster action — three independent on/off switches. */
export interface LanderAction {
  /** Main engine: accelerates along the lander's local up axis. */
  main: boolean;
  /** Left RCS thruster: applies positive (anti-clockwise) torque. */
  left: boolean;
  /** Right RCS thruster: applies negative (clockwise) torque. */
  right: boolean;
}

/** Physical parameters governing the lander's dynamics. */
export interface LanderParams {
  /** Gravitational acceleration (m/s^2). Lunar default ≈ 1.62. */
  gravity: number;
  /** Linear acceleration produced by the main engine (m/s^2). */
  mainAccel: number;
  /** Angular acceleration produced by either RCS thruster (rad/s^2). */
  rcsAngularAccel: number;
  /** Fuel consumed per second of main thrust. */
  fuelBurnMain: number;
  /** Fuel consumed per second of RCS thrust (per side). */
  fuelBurnRcs: number;
  /** Simulation time step (seconds). */
  timeStep: number;
}

/** Default parameters — tuned to keep the example tractable. */
export const DEFAULT_PARAMS: LanderParams = {
  gravity: 1.62,
  mainAccel: 5.0,
  rcsAngularAccel: 1.5,
  fuelBurnMain: 0.5,
  fuelBurnRcs: 0.1,
  timeStep: 0.1,
};

/** Layout of the world the lander operates within. */
export interface LanderTerrain {
  /** Ground plane altitude (metres). */
  groundY: number;
  /** Half-width of the flat landing pad (metres). */
  padHalfWidth: number;
  /** Horizontal centre of the landing pad (metres). */
  padX: number;
  /** Half-width of the playable world (metres). Beyond this is out-of-bounds. */
  worldHalfWidth: number;
}

/** Default terrain: flat pad centred at the origin. */
export const DEFAULT_TERRAIN: LanderTerrain = {
  groundY: 0,
  padHalfWidth: 8,
  padX: 0,
  worldHalfWidth: 50,
};

/**
 * Maximum downward velocity (m/s) at touchdown for a safe landing —
 * stricter values are crashes. The sign convention: `vy` is negative
 * when falling, so the test is `vy >= -SAFE_LANDING_VY_MAGNITUDE`.
 */
export const SAFE_LANDING_VY_MAGNITUDE = 2.0;

/** Maximum sideways speed (m/s) at touchdown for a safe landing. */
export const SAFE_LANDING_VX_MAGNITUDE = 2.0;

/** Maximum tilt (radians) at touchdown for a safe landing. ≈ 11.5°. */
export const SAFE_LANDING_ANGLE = 0.2;

/** Default starting altitude used by {@link initialState}. */
export const DEFAULT_START_ALTITUDE = 80;

/** Default starting fuel allowance. */
export const DEFAULT_START_FUEL = 100;

/**
 * Default starting horizontal offset (metres). Issue #72: the lander
 * begins off the pad so the controller has to translate sideways
 * while fighting gravity and a finite fuel budget — matching the
 * classic Atari Lunar Lander challenge.
 */
export const DEFAULT_START_X = -20;

/**
 * Default starting horizontal velocity (m/s). A modest drift towards
 * the pad on entry; the controller must brake before it overshoots.
 */
export const DEFAULT_START_VX = 2;

/**
 * Build the canonical initial state: lander entering from the upper
 * left, drifting towards the pad, upright, full fuel. The horizontal
 * offset and drift force the controller to actively manoeuvre rather
 * than simply throttle vertical descent.
 */
export function initialState(
  overrides: Partial<LanderState> = {},
): LanderState {
  return {
    x: DEFAULT_START_X,
    y: DEFAULT_START_ALTITUDE,
    vx: DEFAULT_START_VX,
    vy: 0,
    angle: 0,
    angularV: 0,
    fuel: DEFAULT_START_FUEL,
    ...overrides,
  };
}

/**
 * Per-component sampling ranges used by {@link perturbedInitialState}
 * and {@link perturbedScenario} at `magnitude=1`. Ranges are chosen so
 * every drawn scenario is recoverable by an ideal controller — the
 * lander always starts above the ground, inside world bounds, with
 * enough altitude and fuel to react.
 *
 * Issue #195: ranges were widened so a champion cannot win by
 * memorising a single trajectory. Each value is the symmetric half-
 * range (i.e. the sampled offset is uniform on `[-r, +r]`).
 */
export const WIDE_RANGES = {
  /** Horizontal offset around {@link DEFAULT_START_X} (metres). */
  x: 25,
  /** Altitude offset around {@link DEFAULT_START_ALTITUDE} (metres). */
  y: 20,
  /** Horizontal-velocity offset around {@link DEFAULT_START_VX} (m/s). */
  vx: 3,
  /** Vertical-velocity offset around 0 (m/s). */
  vy: 2,
  /** Tilt offset around 0 (radians; ≈ ±14° at `m=1`). */
  angle: 0.25,
  /** Fuel offset around {@link DEFAULT_START_FUEL}. */
  fuel: 20,
  /** Pad-centre horizontal offset around 0 (metres). */
  padX: 20,
} as const;

/** A complete starting condition: lander state plus its terrain. */
export interface LanderScenario {
  /** Starting state of the lander. */
  state: LanderState;
  /** Terrain the lander operates within (notably `padX`). */
  terrain: LanderTerrain;
}

/**
 * Sample a perturbed starting state from the wider scenario
 * distribution. Used to evaluate a controller across a batch of varied
 * initial conditions so robustness — not a single lucky launch — drives
 * selection. Each component is sampled around the canonical
 * {@link initialState} centre using independent uniform draws scaled by
 * `magnitude`. The per-component half-ranges at `magnitude=1` come from
 * {@link WIDE_RANGES}:
 *
 *   - `x` ± `WIDE_RANGES.x * m` metres around `DEFAULT_START_X`
 *   - `y` ± `WIDE_RANGES.y * m` metres around `DEFAULT_START_ALTITUDE`
 *   - `vx` ± `WIDE_RANGES.vx * m` m/s around `DEFAULT_START_VX`
 *   - `vy` ± `WIDE_RANGES.vy * m` m/s around 0
 *   - `angle` ± `WIDE_RANGES.angle * m` radians around 0
 *   - `fuel` ± `WIDE_RANGES.fuel * m` units around `DEFAULT_START_FUEL`
 *
 * Issue #195: the legacy distribution was much narrower (≈ ±5 m, ±0.5
 * m/s, ±0.05 rad, fuel fixed). Widening forces the controller to learn
 * a real recovery policy rather than memorise one trajectory. Note
 * that `padX` does **not** vary here — use {@link perturbedScenario}
 * if pad-centre variation is also required.
 *
 * The angular velocity is held fixed at 0 so every trial starts
 * spinning-free.
 *
 * @param random Deterministic PRNG returning values in `[0, 1)`.
 * @param magnitude Scaling factor for the per-component perturbation.
 */
export function perturbedInitialState(
  random: () => number,
  magnitude: number = 1.0,
): LanderState {
  const sample = (range: number) => (random() * 2 - 1) * range;
  return {
    x: DEFAULT_START_X + sample(WIDE_RANGES.x * magnitude),
    y: DEFAULT_START_ALTITUDE + sample(WIDE_RANGES.y * magnitude),
    vx: DEFAULT_START_VX + sample(WIDE_RANGES.vx * magnitude),
    vy: sample(WIDE_RANGES.vy * magnitude),
    angle: sample(WIDE_RANGES.angle * magnitude),
    angularV: 0,
    fuel: DEFAULT_START_FUEL + sample(WIDE_RANGES.fuel * magnitude),
  };
}

/**
 * Sample a perturbed scenario — both starting state and terrain. The
 * state components are drawn exactly as in {@link perturbedInitialState};
 * additionally, the pad's horizontal centre `padX` is sampled uniformly
 * on `[-WIDE_RANGES.padX * m, +WIDE_RANGES.padX * m]` while the rest of
 * the terrain (ground level, pad half-width, world half-width) stays at
 * {@link DEFAULT_TERRAIN}.
 *
 * Every drawn scenario classifies as `flying` at `t=0`: the altitude
 * offset is bounded so `y > groundY`, and the horizontal offset plus
 * `DEFAULT_START_X` keep `|x| < worldHalfWidth`.
 *
 * @param random Deterministic PRNG returning values in `[0, 1)`.
 * @param magnitude Scaling factor for the per-component perturbation.
 */
export function perturbedScenario(
  random: () => number,
  magnitude: number = 1.0,
): LanderScenario {
  const sample = (range: number) => (random() * 2 - 1) * range;
  const state: LanderState = {
    x: DEFAULT_START_X + sample(WIDE_RANGES.x * magnitude),
    y: DEFAULT_START_ALTITUDE + sample(WIDE_RANGES.y * magnitude),
    vx: DEFAULT_START_VX + sample(WIDE_RANGES.vx * magnitude),
    vy: sample(WIDE_RANGES.vy * magnitude),
    angle: sample(WIDE_RANGES.angle * magnitude),
    angularV: 0,
    fuel: DEFAULT_START_FUEL + sample(WIDE_RANGES.fuel * magnitude),
  };
  const terrain: LanderTerrain = {
    ...DEFAULT_TERRAIN,
    padX: sample(WIDE_RANGES.padX * magnitude),
  };
  return { state, terrain };
}

/**
 * Normalised measure of how far a scenario sits from the canonical
 * training launch (centred start, centred pad). Larger values mean a
 * more demanding initial condition — offset pad, horizontal mismatch
 * to the pad, tilt, and non-default velocities. Used when picking the
 * descent screenshot so the hero replay favours a challenging landing.
 */
export function scenarioComplexity(
  state: LanderState,
  terrain: LanderTerrain,
): number {
  const norm = (delta: number, halfRange: number) =>
    halfRange > 0 ? Math.abs(delta) / halfRange : 0;
  return (
    norm(state.x - terrain.padX, WIDE_RANGES.x) +
    norm(state.x - DEFAULT_START_X, WIDE_RANGES.x) +
    norm(terrain.padX, WIDE_RANGES.padX) +
    norm(state.y - DEFAULT_START_ALTITUDE, WIDE_RANGES.y) +
    norm(state.vx - DEFAULT_START_VX, WIDE_RANGES.vx) +
    norm(state.vy, WIDE_RANGES.vy) +
    norm(state.angle, WIDE_RANGES.angle)
  );
}

/**
 * Advance the lander by one time step using semi-implicit Euler
 * integration. Velocities are updated first, then positions, so the
 * step is energy-stable for small `timeStep` values.
 *
 * Thrusters silently no-op when fuel is exhausted.
 *
 * @param state Current state of the lander.
 * @param action Which thrusters are firing this step.
 * @param params Physical parameters (defaults to {@link DEFAULT_PARAMS}).
 * @returns The state after one time step. The input state is not mutated.
 */
export function step(
  state: LanderState,
  action: LanderAction,
  params: LanderParams = DEFAULT_PARAMS,
): LanderState {
  const dt = params.timeStep;
  const hasFuel = state.fuel > 0;

  let vx = state.vx;
  let vy = state.vy;
  let angularV = state.angularV;
  let fuel = state.fuel;

  if (action.main && hasFuel) {
    // Local-up direction in world coordinates. With angle=0 the lander
    // points straight up: thrust adds to vy and nothing to vx.
    const ax = -Math.sin(state.angle) * params.mainAccel;
    const ay = Math.cos(state.angle) * params.mainAccel;
    vx += ax * dt;
    vy += ay * dt;
    fuel -= params.fuelBurnMain * dt;
  }

  if (action.left && hasFuel) {
    angularV += params.rcsAngularAccel * dt;
    fuel -= params.fuelBurnRcs * dt;
  }
  if (action.right && hasFuel) {
    angularV -= params.rcsAngularAccel * dt;
    fuel -= params.fuelBurnRcs * dt;
  }

  // Gravity acts last so it always applies, even when no fuel remains.
  vy -= params.gravity * dt;

  const x = state.x + vx * dt;
  const y = state.y + vy * dt;
  const angle = state.angle + angularV * dt;

  return {
    x,
    y,
    vx,
    vy,
    angle,
    angularV,
    fuel: fuel < 0 ? 0 : fuel,
  };
}

/** Possible terminal classifications for a lander state. */
export type LanderOutcome = "flying" | "landed" | "crashed" | "out_of_bounds";

/**
 * Classify the current state. While the lander is above the ground and
 * within the world bounds the outcome is `"flying"`. The first frame at
 * or below `groundY` is classified as either `"landed"` (on the pad,
 * upright, slow) or `"crashed"` (anything else). Drifting past
 * `worldHalfWidth` is `"out_of_bounds"`.
 */
export function classifyOutcome(
  state: LanderState,
  terrain: LanderTerrain = DEFAULT_TERRAIN,
): LanderOutcome {
  if (Math.abs(state.x) > terrain.worldHalfWidth) {
    return "out_of_bounds";
  }
  if (state.y > terrain.groundY) {
    return "flying";
  }
  const onPad = Math.abs(state.x - terrain.padX) <= terrain.padHalfWidth;
  const upright = Math.abs(state.angle) <= SAFE_LANDING_ANGLE;
  const slowVertical = state.vy >= -SAFE_LANDING_VY_MAGNITUDE;
  const slowHorizontal = Math.abs(state.vx) <= SAFE_LANDING_VX_MAGNITUDE;
  if (onPad && upright && slowVertical && slowHorizontal) {
    return "landed";
  }
  return "crashed";
}

/** True when the lander has reached a terminal state (anything but flying). */
export function isTerminal(
  state: LanderState,
  terrain: LanderTerrain = DEFAULT_TERRAIN,
): boolean {
  return classifyOutcome(state, terrain) !== "flying";
}

/**
 * Encode a {@link LanderState} as a Float32Array suitable for feeding
 * into a NEAT-AI creature. Values are normalised into comparable ranges:
 * `[relativeX, altitude, vx, vy, angle, angularV, fuel]`, where
 * `relativeX` is measured against the active landing pad.
 */
export function encodeState(
  state: LanderState,
  terrain: LanderTerrain = DEFAULT_TERRAIN,
): Float32Array {
  const clamp = (value: number, min: number, max: number) =>
    value < min ? min : value > max ? max : value;
  const altitudeMax = DEFAULT_START_ALTITUDE + WIDE_RANGES.y;
  const fuelMax = DEFAULT_START_FUEL + WIDE_RANGES.fuel;
  const velocityMax = 25;
  const spinMax = 5;
  return new Float32Array([
    clamp((state.x - terrain.padX) / terrain.worldHalfWidth, -1, 1),
    clamp((state.y - terrain.groundY) / altitudeMax, 0, 1),
    clamp(state.vx / velocityMax, -1, 1),
    clamp(state.vy / velocityMax, -1, 1),
    clamp(state.angle / Math.PI, -1, 1),
    clamp(state.angularV / spinMax, -1, 1),
    clamp(state.fuel / fuelMax, 0, 1),
  ]);
}

/** A no-op action (all thrusters off). Useful as a sentinel and for tests. */
export const NO_ACTION: LanderAction = { main: false, left: false, right: false };

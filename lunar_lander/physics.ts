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
 * Sample a perturbed starting state. Used to evaluate a controller
 * across a fixed batch of varied initial conditions so robustness — not
 * a single lucky launch — drives selection. Each component is sampled
 * around the canonical {@link initialState} centre using independent
 * uniform draws scaled by `magnitude`:
 *
 *   - `x` ± 5·m metres of horizontal offset
 *   - `y` ± 5·m metres of altitude
 *   - `vx`, `vy` ± 0.5·m m/s
 *   - `angle` ± 0.05·m radians (≈ ±2.9° at `m=1`)
 *
 * Fuel and angular velocity are held fixed so every trial in a batch
 * starts with the same propellant budget.
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
    x: DEFAULT_START_X + sample(5 * magnitude),
    y: DEFAULT_START_ALTITUDE + sample(5 * magnitude),
    vx: DEFAULT_START_VX + sample(0.5 * magnitude),
    vy: sample(0.5 * magnitude),
    angle: sample(0.05 * magnitude),
    angularV: 0,
    fuel: DEFAULT_START_FUEL,
  };
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
 * into a NEAT-AI creature: `[x, y, vx, vy, angle, angularV, fuel]`.
 */
export function encodeState(state: LanderState): Float32Array {
  return new Float32Array([
    state.x,
    state.y,
    state.vx,
    state.vy,
    state.angle,
    state.angularV,
    state.fuel,
  ]);
}

/** A no-op action (all thrusters off). Useful as a sentinel and for tests. */
export const NO_ACTION: LanderAction = { main: false, left: false, right: false };

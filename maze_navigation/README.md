# 🗺️ Maze Navigation — Evolved Agent for a Grid Maze

> 🌱 **Generation 1 starts from random noise** — the initial population is built by NEAT-AI's
> uniform-random `Creature(5, 4)` constructor, with **no hand-crafted topology and no tuned weight
> init**. Structural mutation grows hidden neurons during evolution; the captured milestones show
> the agent climbing from a gen-1 wall-bumper to a network that walks straight from start to goal.

**Acronyms.** _NEAT_ = NeuroEvolution of Augmenting Topologies. _PRNG_ = pseudorandom number
generator.

`maze_navigation.ts` evolves a NEAT-AI controller that navigates a fixed 12×12 grid maze from a
start cell to a goal cell using only local sensor inputs (wall distances plus a packed
heading-to-goal). The simulator (`maze.ts`), evolutionary loop, and animated SVG renderer (`svg.ts`)
all run in pure TypeScript; the only external dependency is NEAT-AI's `Creature.activate` to compute
each step's action.

![Champion run](../docs/screenshots/maze_navigation.svg)

## 🔧 How It Works

```mermaid
flowchart LR
    MAZE["🗺️ Static grid maze<br/>(maze.ts)"]
    INIT["🎲 Uniform-Random NEAT<br/>new Creature(5, 4)"]
    SENSE["🛰️ Wall + heading sensors<br/>(agent.ts)"]
    POLICY["🧠 Network → cardinal action"]
    STEP["🚶 Step or block on wall"]
    DONE{"goal reached<br/>or 200-step cap?"}
    SCORE["📏 Score = f(distance, steps)"]
    SELECT["🏆 Truncation Selection<br/>top 50% are parents"]
    MUTATE["🧬 Mutate: weights · biases · add-neuron"]
    SOLVED{"Score ≥ 1 − targetError?"}
    CAP{"timeoutMinutes elapsed?"}
    SVG["🖼️ Animated maze SVG"]

    INIT --> SENSE
    MAZE --> SENSE
    SENSE --> POLICY --> STEP --> DONE
    DONE -- no --> SENSE
    DONE -- yes --> SCORE --> SOLVED
    SOLVED -- no --> CAP
    CAP -- no --> SELECT --> MUTATE --> SENSE
    SOLVED -- yes --> SVG
    CAP -- yes (give up) --> SVG

    style MAZE fill:#27ae60,stroke:#333,color:#fff
    style INIT fill:#f5a623,stroke:#333,color:#fff
    style SENSE fill:#3498db,stroke:#333,color:#fff
    style POLICY fill:#9b59b6,stroke:#333,color:#fff
    style STEP fill:#f39c12,stroke:#333,color:#fff
    style SCORE fill:#e67e22,stroke:#333,color:#fff
    style SELECT fill:#e74c3c,stroke:#333,color:#fff
    style MUTATE fill:#c0392b,stroke:#333,color:#fff
    style SVG fill:#f1c40f,stroke:#333,color:#000
```

## 🗺️ Maze Layout

The default maze is encoded as a string-art template — `S` marks the start, `G` the goal, `#` walls
and `.` open cells. The path is an L-shape: nine cells east along the top row, then nine cells south
down the rightmost open column.

```text
############
#S.........#
##########.#
##########.#
##########.#
##########.#
##########.#
##########.#
##########.#
##########.#
##########G#
############
```

## 🎯 Inputs and Outputs

The agent observes a small sensor pack (5 channels):

| Channel  | Type       | Symbol    | Meaning                                             |
| -------- | ---------- | --------- | --------------------------------------------------- |
| Input 0  | observable | `wallN`   | Free cells to the north, capped at 6, normalised    |
| Input 1  | observable | `wallE`   | Free cells to the east                              |
| Input 2  | observable | `wallS`   | Free cells to the south                             |
| Input 3  | observable | `wallW`   | Free cells to the west                              |
| Input 4  | observable | `heading` | Packed unit-vector heading-to-goal: `(ux + uy) / 2` |
| Output 0 | action     | —         | Argmax → action **North**                           |
| Output 1 | action     | —         | Argmax → action **East**                            |
| Output 2 | action     | —         | Argmax → action **South**                           |
| Output 3 | action     | —         | Argmax → action **West**                            |

Each tick the controller chooses one of the four cardinal moves; if the destination is a wall or
off-grid the agent stays put. Episodes end when the agent reaches the goal or the 200-step cap
fires.

## 📏 Scoring and Solved Threshold

```text
score = 1 / (1 + manhattan_to_goal_at_terminal_step) − step_count × 0.001
```

Reaching the goal scores at least `1 − 200 × 0.001 = 0.8` (the worst possible reached run, taking
the full step cap to arrive). The optimal 18-step path along the L-shape scores `1 − 0.018 = 0.982`.
A controller that gets stuck even one cell from the goal scores at most `1 / 2 − 0.001 = 0.499`. The
task is therefore declared **solved** when the champion's score reaches `SOLVED_THRESHOLD = 0.6` —
comfortably above every non-reached run yet trivially achievable by any trajectory that ends on the
goal cell.

### 🛑 Stop conditions

The evolutionary loop uses NEAT-AI's two standard stop conditions, configured via `EvolveOptions`:

- `targetError = 1 − SOLVED_THRESHOLD = 0.4` — evolution halts as soon as the champion's score
  reaches `1 − targetError = 0.6` (i.e. the agent reaches the goal).
- `timeoutMinutes = 5` — wall-clock backstop. Whichever fires first wins. Five minutes is generous
  for the L-corridor maze on a commodity laptop; the captured run below converged in under six
  seconds.

A per-step `activate()` is retained because the maze is an interactive simulation — the agent's next
sensor reading depends on the action it chose at the previous step, so there is no static binary
`.bin` training set the library could consume in a single batched pass.

## 🚀 Running the Example

```bash
./maze_navigation/run.sh
```

Artefacts:

- `.synthetic-maze/creatures/champion.json` – the fittest controller from the run
- `.synthetic-maze/output/trajectory.json` – the champion's step-by-step trajectory log
- `docs/screenshots/maze_navigation.svg` – animated SVG of the champion's run
- [`docs/screenshots/maze_navigation_milestones.svg`](../docs/screenshots/maze_navigation_milestones.svg)
  – dual-axis milestone-statistics chart rendered from the `evolveRL` milestone stream
  (`renderMilestoneChartSVG` from [`common/milestone_chart.ts`](../common/milestone_chart.ts))

## Evolution Progress

Per issue [#298](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/298) NEAT-AI surfaces only
milestone-cadence telemetry (`evolverl_milestone` events at generations
`1, 2, 5, 10, 20, 50, 100, 200, 500, 1000`, then powers of ten). The legacy per-generation evolution
strip, fitness chart, and topology chart have been replaced by a single milestone-statistics chart
sourced from the `EvolveRLMilestone[]` array `Creature.evolveRL()` returns when `statistics: true`
is set. The maze-navigation runner registers **no `onTrainingEvent` handler** — the milestone array
is read straight from the run summary and rendered with `renderMilestoneChartSVG` (see issue
[#287](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/287)).

![Maze Navigation milestone chart — best score and mean episode steps on the left axis, with champion neuron and synapse counts on the right axis, plotted against milestone generation on a log-X axis](../docs/screenshots/maze_navigation_milestones.svg)

Re-run `./maze_navigation/run.sh` to refresh the milestone chart and the run-replay SVG together.

Generation 1 — the first milestone — is the **uniform-random NEAT population** straight from
`new Creature(5, 4)`: direct input → output connections with weights and biases drawn by the
library's RNG. Subsequent milestones (gens 10 / 100 / 1000) show the controller learning to follow
walls and head toward the goal; the final milestone meets the threshold and reaches the goal in the
optimal 18 steps.

## 🧠 Tacit Knowledge

A few things that are not obvious from the code alone:

- **No hand-crafted topology.** `maze_navigation.ts` never hard-codes neurons or synapses. The
  initial population is built with `createSeededPopulation({ inputCount: 5, outputCount: 4, ... })`
  which delegates to `new Creature(5, 4)` for every member. Hidden neurons appear only when the
  add-neuron mutation operator splits an existing connection during evolution — structural mutation
  discovers them.
- **Linear policy is enough on the L-shape.** Five inputs and four outputs (20 weights, 4 biases) is
  a small enough search space that an 80-creature population, starting from uniform-random NEAT
  noise, finds a goal-reaching controller in tens of generations. There is no hidden layer required
  — the wall-distance sensors carry enough information for the network to learn "head where there is
  space". Hidden neurons grown by the add-neuron operator can refine the policy further but are not
  necessary to clear the L-shape.
- **Argmax discretisation.** The four outputs are passed through `argmax` — the controller commits
  to one of four cardinal moves every step regardless of the squash function the library picks for
  the output neurons. The `Stay` action is never emitted.
- **Walls block, they do not kill.** Bumping into a wall leaves the agent's position unchanged but
  still consumes a tick, so prolonged wall-bumping erodes the score via the per-step penalty.
- **Reproducibility.** All randomness flows through `common/deterministic_random.ts` and the
  library's seeded RNG (`createSeededRng(seed)`). With a fixed seed the same champion is produced on
  every run.
- **Same maze every time.** The maze is encoded as a string-art template, parsed once at start-up,
  and reused by every controller in the population — fitness comparisons are fair.
- **Audit-mandated stop conditions.** Evolution stops as soon as the champion's score reaches
  `1 − targetError` (default `0.6`) **or** `timeoutMinutes` minutes of wall-clock have elapsed
  (default `5`) — whichever fires first. The two stop conditions match NEAT-AI's standard
  `NeatOptions.targetError` / `NeatOptions.timeoutMinutes` fields. An optional `iterations` cap is
  available for unit tests that need a deterministic generation count without depending on
  wall-clock timing; the captured run never relies on it.

## 🧰 NEAT-AI Features Used

Maze Navigation is an evolution-from-noise agent demo, so the demonstrated capability is NEAT-AI's
evolutionary topology search driven by an episode-rollout fitness signal.

> 🔎 **Stripped-down operator subset.** This example deliberately exercises a narrow slice of
> NEAT-AI's full pipeline so the noise → competent story stays uncluttered. The production training
> pipeline (backpropagation, dropout, L1/L2 regularisation, K-fold, binary `.bin` data streams,
> distributed evolution, etc.) is intentionally **not** wired into this demo — see issue
> [#185](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/185) and the upstream
> production-pipeline notes in
> [`COMPARISON.md`](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md) for the
> wider feature set.

Features exercised (links go to upstream
[`COMPARISON.md`](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md)):

- **[Evolutionary Topology Search](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md#what-weve-implemented)**
  — structural mutation co-evolved with weights against the maze-traversal fitness signal.
- **[Genetic Operators](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md#what-weve-implemented)**
  — weight and bias mutation paired with selection pressure on the per-episode reward.

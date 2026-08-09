# ⚡ NEAT-AI's Binary `.bin` Training Stream

NEAT-AI's training pipeline reads training data as **chunked little-endian Float32** records — one
flat binary file per chunk, no headers, no JSON, no CSV. There is no parser on the hot path.
`creature.evolveDir(dir, …)` and `creature.scoreDir(dir, …)` just `mmap`/stream the bytes and feed
them straight to the WASM evaluator.

This page exists because the `.bin` stream is one of NEAT-AI's most consequential performance
features and is currently almost invisible in the example READMEs. To quote the reporter on issue
#182: _"if the training data is prepared in a binary format that would be very fast indeed."_ — they
are right; it already is.

## 📐 Wire format

Each `.bin` file is a flat sequence of `Float32` (IEEE-754, 32-bit, little-endian) records. For a
creature with `I` inputs and `O` outputs, every record is:

```text
[ input_0, input_1, …, input_{I-1}, target_0, target_1, …, target_{O-1} ]
```

- **Stride** is `(I + O) * 4` bytes, fixed.
- **Records per file** is configurable (`recordsPerFile` in `SyntheticConfig`); a dataset can be
  split across `synthetic_0000.bin`, `synthetic_0001.bin`, …
- **No headers, no padding, no separators.** The file size is exactly `records × (I + O) × 4` bytes.

The writer side is `common/synthetic_data.ts::generateSyntheticData(...)`:

```ts
const buffer = new Uint8Array(bytesPerRecord * batchSize);
const view = new Float32Array(buffer.buffer);
// fill view[...] with inputs and target outputs
Deno.writeFileSync(filePath, buffer);
```

`xor_classification` uses the same shape directly (it writes a single `xor.bin` without going
through `generateSyntheticData`), and the rest of the examples below delegate to the shared helper.

## 🚀 Why binary is fast

The argument is asymptotic, not magical:

| Format          | Bytes per Float32 feature | Parsing cost per feature |
| --------------- | ------------------------- | ------------------------ |
| Binary `.bin`   | **4**                     | **O(1)** — direct read   |
| CSV / JSON text | typically 8–18            | O(N) — scan + parse      |

For a dataset of `R` records with `F = I + O` features per record:

- **Binary path** — total bytes read is `4 · R · F`; per-feature cost is a single `Float32Array`
  index (a couple of CPU instructions). Decode time is dominated by page-cache hit/miss and memory
  bandwidth, not parsing.
- **Text path** — total bytes read is roughly `8 · R · F` to `18 · R · F`, and every feature costs
  an O(length) scan plus a `parseFloat` call. The parser is what burns the wall clock on large
  datasets.

Concretely, NEAT-AI's WASM evaluator can read a `.bin` chunk into a `Float32Array` and pass it to
fitness evaluation with **zero parsing**. There is no `JSON.parse`, no CSV tokeniser, no number
coercion — the bytes already _are_ the numbers the evaluator needs.

For a fixed-size dataset, this typically translates to a 5–20× wall-clock improvement on data
loading versus a CSV equivalent, and the gap widens with record size because text per-feature cost
scales linearly with the number of digits while binary stays at exactly 4 bytes. We do not commit a
benchmark script for this comparison — the asymptotic argument is the load-bearing claim and a
benchmark on synthetic data would only re-derive it.

## 🗺️ Pipeline

```mermaid
flowchart LR
    A[🧬 Dataset]
    B[📝 .bin writer<br/>generateSyntheticData]
    C[💾 chunked .bin files<br/>synthetic_0000.bin …]
    D[🚀 creature.evolveDir<br/>WASM evaluator]
    E[🎯 fitness score]

    A -->|Float32 records| B
    B -->|"(I+O)·4 bytes/record"| C
    C -->|stream / mmap| D
    D --> E
```

Reading direction:

1. The example produces a deterministic `Float32` record stream (inputs + targets) using a seeded
   PRNG.
2. `generateSyntheticData` (or the example's own writer, in the case of `xor_classification`) packs
   the records into one or more `.bin` files in the example's hidden working directory.
3. `creature.evolveDir(dataDir, …)` (or `creature.scoreDir(dataDir, …)`) walks every `.bin` file in
   the directory and streams the bytes straight into the WASM evaluator. No JSON, no CSV, no parsing
   — just `Float32Array` views over the file bytes.
4. Each record contributes to the fitness signal that drives evolution.

## 📚 Examples that emit a `.bin` file

These examples produce `.bin` chunks at runtime via the shared writer (`common/synthetic_data.ts`)
or, in the XOR case, an inline writer that emits the identical format:

| Example              | Writer                                             | Working directory                                    |
| -------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `xor_classification` | `writeXorDataset(dataDir)` — inline Float32 writer | `.synthetic-xor/data/xor.bin`                        |
| `discovery`          | `generateSyntheticData(referenceCreature, …)`      | `.synthetic-discovery/data/synthetic_*.bin`          |
| `discovery_at_scale` | `generateSyntheticData(baseline, …)`               | `.discovery-at-scale/data/synthetic_*.bin`           |
| `crispr_injection`   | `generateSyntheticData(target, …)`                 | `.synthetic-crispr-injection/data/synthetic_*.bin`   |
| `evolution_showcase` | `generateSyntheticData(teacher, …)`                | `.synthetic-evolution-showcase/data/synthetic_*.bin` |
| `crossover`          | `generateSyntheticData(parentA, …)`                | `.synthetic-crossover/data/synthetic_*.bin`          |
| `intelligent_design` | `generateSyntheticData(creature, …)`               | `.synthetic-intelligent-design/data/synthetic_*.bin` |

## 📦 Examples that emit a single `training.bin`

Four examples generate one dataset up front rather than a chunked stream. They all call the shared
`common/synthetic_data.ts::writeBinaryDataset(dataset, dataDir, inputCount, outputCount)`, which
writes exactly the record layout described above into `<dataDir>/training.bin`
([#777](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/777)):

| Example                | Record shape                                  | Working directory                                   |
| ---------------------- | --------------------------------------------- | --------------------------------------------------- |
| `memetic_evolution`    | 2 inputs → 1 output (fixed arity)             | `.synthetic-memetic-evolution/data/training.bin`    |
| `suggest_improvements` | 2 inputs → 1 output (fixed arity)             | `.synthetic-suggest-improvements/data/training.bin` |
| `neuron_pruning`       | arbitrary arity, labelled by a target network | `.neuron-pruning/data/training.bin`                 |
| `synthetic_synapse`    | arbitrary arity, labelled by a target network | `.synthetic-synapse/data/training.bin`              |

The two network-driven examples build their datasets with the shared
`generateNetworkDataset(targetNetwork, size, seed)` — uniform `[-1, 1]` inputs fed through the
target network, whose outputs become the labels.

## 🧭 Related examples that discuss the `.bin` stream

These examples do not currently emit a `.bin` file themselves, but their READMEs discuss the binary
training-data path as a NEAT-AI feature worth knowing about:

- **`mnist_classification`** — operates on the canonical MNIST IDX gzip files directly to keep the
  example self-contained. Its README's "Where NEAT-AI is faster than this demo suggests" section
  calls out the IDX → `.bin` path as the production accelerator that the demo deliberately leaves
  out.

`synthetic_synapse` also discusses the stream in its README, but it does emit a `.bin` — see the
`training.bin` table above.

## 🔗 See also

- [`common/synthetic_data.ts`](../common/synthetic_data.ts) — the shared Float32-record writer.
- [`xor_classification/xor_classification.ts`](../xor_classification/xor_classification.ts) —
  `writeXorDataset(...)`, an inline writer that emits the identical format for a single small file.
- Issue [#182](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/182) — the original "make
  NEAT-AI's speed advantages visible" thread.

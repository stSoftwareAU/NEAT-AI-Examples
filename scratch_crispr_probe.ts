// scratch — delete before commit
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { createTargetCreature, runCrisprInjectionEvolution } from "./crispr_injection/crispr_injection.ts";
import { generateSyntheticData } from "./common/synthetic_data.ts";

const reps = Number(Deno.args[0] ?? "10");
for (let i = 0; i < reps; i++) {
  const tmpDir = Deno.makeTempDirSync({ prefix: "crispr_probe_" });
  const dataDir = join(tmpDir, "data");
  ensureDirSync(dataDir);
  const target = createTargetCreature();
  target.validate();
  generateSyntheticData(target, dataDir, { totalRecords: 64, recordsPerFile: 64, seed: 42 });
  const r = await runCrisprInjectionEvolution(dataDir, {
    targetError: 0.0001,
    timeoutMinutes: 10,
    populationSize: 16,
    maxIterations: Number(Deno.args[1] ?? "400"),
    seed: 209,
  });
  console.error(
    `REP ${i} pre score=${r.pre.summary.finalScore.toFixed(6)} err=${r.pre.finalError.toFixed(6)} gen=${r.pre.generations} solved=${r.pre.solved} | post score=${
      r.post.summary.finalScore.toFixed(6)
    } err=${r.post.finalError.toFixed(6)} gen=${r.post.generations} solved=${r.post.solved} | delta=${
      (r.post.summary.finalScore - r.pre.summary.finalScore).toFixed(6)
    }`,
  );
  Deno.removeSync(tmpDir, { recursive: true });
}

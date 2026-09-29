// Regression tests for issue #872: the MNIST Lamarck/Backprop campaign must
// launch its hold-out scorer with the scoped Deno permissions the rest of the
// repo uses (issue #419), never bare --allow-net / --allow-env / --allow-sys.
//
// Behavioural: the real campaign script runs one cycle in a throwaway repo
// layout with a stub `deno` on PATH that records the argv it receives, so the
// assertions are on the permissions the campaign actually grants.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const CAMPAIGN = fromFileUrl(new URL("./mnist_lamarck_backprop_campaign.sh", import.meta.url));

/** Hosts the hold-out scorer legitimately reaches: MNIST dataset + NEAT-AI WASM. */
const ALLOWED_HOSTS = new Set(["storage.googleapis.com", "jsr.io"]);
const ALLOWED_SYS = new Set(["systemMemoryInfo", "hostname"]);
const SECRET_ENV = ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

const STUB_DENO = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s\\n' "$@"; echo "--END--"; } >> "\${STUB_DENO_LOG}"
score='{"path":"x","testAccuracy":0.95,"validationAccuracy":0.95,"neurons":1,"synapses":1}'
if [[ " $* " == *" --compare "* ]]; then
  echo "{\\"before\\":\${score},\\"after\\":\${score},\\"improved\\":false}"
  exit 1
fi
echo "\${score}"
`;

// Writes best.json into --output-dir so the campaign reaches its compare gate.
const STUB_LAMARCK = `#!/usr/bin/env bash
set -euo pipefail
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--output-dir" ]]; then echo '{}' > "$2/best.json"; fi
  shift
done
`;

async function writeExecutable(path: string, body: string): Promise<void> {
  await Deno.writeTextFile(path, body);
  await Deno.chmod(path, 0o755);
}

/** Run one campaign cycle against stubs; return each recorded `deno` argv. */
async function runCampaignAgainstStubs(): Promise<string[][]> {
  const root = await Deno.makeTempDir({ prefix: "campaign-872-" });
  try {
    const bin = join(root, "stub-bin");
    await Deno.mkdir(join(root, "scripts"), { recursive: true });
    await Deno.mkdir(bin);
    await Deno.mkdir(join(root, "docs/data/mnist_classification"), { recursive: true });
    await Deno.mkdir(join(root, ".synthetic-mnist/bin"), { recursive: true });
    await Deno.copyFile(CAMPAIGN, join(root, "scripts/campaign.sh"));
    await Deno.writeTextFile(join(root, "docs/data/mnist_classification/creature.json"), "{}");
    await Deno.writeFile(join(root, ".synthetic-mnist/bin/training.bin"), new Uint8Array(4));
    await writeExecutable(join(bin, "deno"), STUB_DENO);
    await writeExecutable(join(bin, "lamarck"), STUB_LAMARCK);
    await writeExecutable(join(bin, "noop"), "#!/usr/bin/env bash\nexit 0\n");

    const log = join(root, "deno-calls.log");
    const { code, stdout, stderr } = await new Deno.Command("bash", {
      args: [join(root, "scripts/campaign.sh")],
      stdin: "null",
      env: {
        PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
        STUB_DENO_LOG: log,
        NEAT_AI_LAMARCK_BIN: join(bin, "lamarck"),
        NEAT_AI_BACKPROP_BIN: join(bin, "noop"),
        NEAT_AI_SCORER_BIN: join(bin, "noop"),
        MNIST_CAMPAIGN_MAX_HOURS: "1",
        MNIST_TARGET_ACCURACY: "0.90",
      },
    }).output();
    const decoder = new TextDecoder();
    assertEquals(
      code,
      0,
      `campaign failed:\n${decoder.decode(stdout)}\n${decoder.decode(stderr)}`,
    );
    const calls = (await Deno.readTextFile(log)).split("--END--\n").filter((c) => c.trim());
    return calls.map((c) => c.trimEnd().split("\n"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function listValue(argv: string[], flag: string): string[] | undefined {
  const token = argv.find((a) => a.startsWith(`${flag}=`));
  return token?.slice(flag.length + 1).split(",");
}

Deno.test("campaign launches the hold-out scorer with scoped Deno permissions", async () => {
  const calls = await runCampaignAgainstStubs();

  // Baseline, compare gate, post-slice hold-out, final hold-out.
  assert(calls.some((argv) => argv.includes("--compare")), "compare gate never ran");
  assert(calls.filter((argv) => !argv.includes("--compare")).length >= 2, "hold-out never ran");

  for (const argv of calls) {
    const where = `deno ${argv.join(" ")}`;
    for (const bare of ["-A", "--allow-all", "--allow-net", "--allow-env", "--allow-sys"]) {
      assert(!argv.includes(bare), `${where} grants bare ${bare}`);
    }
    assert(argv.includes("--no-prompt"), `${where} may prompt instead of failing loud`);

    const hosts = listValue(argv, "--allow-net");
    assert(hosts, `${where} has no scoped --allow-net`);
    for (const host of hosts) assert(ALLOWED_HOSTS.has(host), `${where} allows host ${host}`);

    const sys = listValue(argv, "--allow-sys");
    assert(sys, `${where} has no scoped --allow-sys`);
    for (const api of sys) assert(ALLOWED_SYS.has(api), `${where} allows sys API ${api}`);

    const env = listValue(argv, "--allow-env");
    assert(env && env.length > 0, `${where} has no scoped --allow-env`);
    for (const name of SECRET_ENV) assert(!env.includes(name), `${where} exposes ${name}`);
  }
});

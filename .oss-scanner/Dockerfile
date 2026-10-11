# OSS Scanner build image (https://github.com/anthropics/oss-scanner).
# The scanner builds this with the repository as the build context, then runs
# its audit offline, so every dependency the examples and their tests need is
# fetched here. CI uses Deno v2.x; the image pins the current 2.9 release.
FROM denoland/deno:debian-2.9.7

ENV DEBIAN_FRONTEND=noninteractive
# bash, git and shellcheck are spawned by the runners and some tests; `df`
# (coreutils) is used by NEAT-AI's disk-space checks.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates bash coreutils git shellcheck \
    && rm -rf /var/lib/apt/lists/*

# NEAT-AI downloads its WASM activation bundle from jsr.io on first use and
# caches it here; a fixed path keeps the cache independent of $HOME.
ENV NEAT_AI_WASM_CACHE_DIR=/opt/neat-ai/wasm

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# Fetch every jsr: module against the lockfile and type-check all sources and
# tests (CI runs `deno check -- **/*.ts`).
RUN deno install --frozen --lock=deno.lock \
    && deno check .

# Warm the runtime caches: the NEAT-AI WASM bundle and the digest-pinned
# MNIST / S&P 500 datasets the examples download on first run.
RUN deno run --frozen --allow-read --allow-write --allow-env \
      --allow-net=jsr.io,storage.googleapis.com,raw.githubusercontent.com \
      .oss-scanner/warm_cache.ts

# Smoke-run a small slice of the unit tests and one quick example; a failure
# warns rather than aborting the build. The NEAT-AI-Discovery library and the
# NEAT-AI-scorer binary are optional and absent, so those paths skip or fall
# back to WASM. The full suite is in quality.sh ("Unit Tests").
RUN (deno test --frozen --no-check -A --reporter=dot \
      common/data_cache_test.ts common/tsp_instances_test.ts \
      xor_classification/xor_classification_test.ts \
      || echo "WARNING: smoke tests reported failures") \
    && (XOR_QUICK=1 ./xor_classification/run.sh \
      || echo "WARNING: XOR quick example reported failures") \
    && rm -rf .synthetic-xor

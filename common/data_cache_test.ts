/**
 * Unit tests for the shared dataset cache helper.
 *
 * These are "what" tests — they verify the observable behaviour of
 * `fetchDataset` (file contents, request counts, error shape) without
 * inspecting the implementation.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";

import { fetchDataset } from "./data_cache.ts";

interface TestServer {
  port: number;
  readonly count: number;
  stop(): Promise<void>;
}

function startServer(handler: (req: Request) => Response | Promise<Response>): TestServer {
  const ac = new AbortController();
  let count = 0;
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    (req) => {
      count++;
      return handler(req);
    },
  );
  return {
    port: (server.addr as Deno.NetAddr).port,
    get count() {
      return count;
    },
    async stop() {
      ac.abort();
      await server.finished;
    },
  };
}

Deno.test("fetchDataset downloads a file and writes the expected bytes", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const expected = new TextEncoder().encode("hello, world");
  const server = startServer(() => new Response(expected));
  const dest = join(tmp, "nested", "hello.bin");

  try {
    const result = await fetchDataset({
      url: `http://localhost:${server.port}/hello.bin`,
      path: dest,
    });

    assertEquals(result, dest, "should return the destination path");
    assertEquals(existsSync(dest), true, "file should exist on disk");
    const got = await Deno.readFile(dest);
    assertEquals(got, expected, "file contents should match the served bytes");
  } finally {
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset uses the on-disk cache on the second call", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const payload = new TextEncoder().encode("cache me");
  const server = startServer(() => new Response(payload));
  const dest = join(tmp, "cached.bin");

  try {
    await fetchDataset({ url: `http://localhost:${server.port}/x`, path: dest });
    await fetchDataset({ url: `http://localhost:${server.port}/x`, path: dest });

    assertEquals(server.count, 1, "second call must not re-download");
  } finally {
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset rejects on digest mismatch and removes the partial file", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const payload = new TextEncoder().encode("payload that will not match");
  const server = startServer(() => new Response(payload));
  const dest = join(tmp, "bad.bin");
  const wrongDigest = "0".repeat(64);

  try {
    await assertRejects(
      () =>
        fetchDataset({
          url: `http://localhost:${server.port}/x`,
          path: dest,
          sha256: wrongDigest,
        }),
      Error,
      "digest",
    );
    assertEquals(existsSync(dest), false, "partial file should be removed on mismatch");
  } finally {
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset falls back to a mirror when the first URL 404s", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const payload = new TextEncoder().encode("from the second mirror");
  const failing = startServer(() => new Response("not found", { status: 404 }));
  const working = startServer(() => new Response(payload));
  const dest = join(tmp, "mirror.bin");

  try {
    await fetchDataset({
      url: [
        `http://localhost:${failing.port}/x`,
        `http://localhost:${working.port}/x`,
      ],
      path: dest,
    });

    const got = await Deno.readFile(dest);
    assertEquals(got, payload, "final file should match the working mirror");
    assertEquals(failing.count, 1, "first mirror should be tried once");
    assertEquals(working.count, 1, "second mirror should be tried once");
  } finally {
    await failing.stop();
    await working.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset writes atomically — final path never sees partial bytes", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const dest = join(tmp, "atomic.bin");
  const partPath = `${dest}.part`;
  const firstChunk = new TextEncoder().encode("first-chunk");

  // The server holds the second chunk until the test releases it, so the
  // download is provably mid-flight while we inspect the on-disk state.
  let releaseSecondChunk!: () => void;
  const secondChunkAllowed = new Promise<void>((resolve) => {
    releaseSecondChunk = resolve;
  });

  const server = startServer(() => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(firstChunk);
        await secondChunkAllowed;
        controller.enqueue(new TextEncoder().encode("-final"));
        controller.close();
      },
    });
    return new Response(stream);
  });

  // `onProgress` fires only once `fetchDataset` has received and written a
  // chunk, so the test observes the real event instead of guessing how long
  // the runtime takes to pump it through. No wall-clock wait (#852).
  let firstChunkWritten!: () => void;
  const firstChunkOnDisk = new Promise<void>((resolve) => {
    firstChunkWritten = resolve;
  });

  const fetchPromise = fetchDataset({
    url: `http://localhost:${server.port}/atomic`,
    path: dest,
    onProgress: () => firstChunkWritten(),
  });
  // Ensure we observe the fetchPromise regardless of teardown order.
  fetchPromise.catch(() => {});

  try {
    // Racing against `fetchPromise` keeps a failed download loud (it
    // rejects here) instead of hanging on a promise that never resolves.
    await Promise.race([firstChunkOnDisk, fetchPromise]);

    const destExistsMidFlight = existsSync(dest);
    const partExistsMidFlight = existsSync(partPath);

    releaseSecondChunk();
    await fetchPromise;

    assertEquals(
      destExistsMidFlight,
      false,
      "final destination must not exist while download is in progress",
    );
    assertEquals(
      partExistsMidFlight,
      true,
      "scratch .part file must hold the in-flight bytes",
    );
    assertEquals(existsSync(dest), true, "final destination should exist after success");
    assertEquals(existsSync(partPath), false, "scratch .part file should be cleaned up");
    const got = await Deno.readFile(dest);
    assertEquals(got, new TextEncoder().encode("first-chunk-final"));
  } finally {
    releaseSecondChunk();
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset does not leave a .part file behind on success", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const payload = new TextEncoder().encode("clean success");
  const server = startServer(() => new Response(payload));
  const dest = join(tmp, "clean.bin");
  const partPath = `${dest}.part`;

  try {
    await fetchDataset({
      url: `http://localhost:${server.port}/x`,
      path: dest,
    });
    assertEquals(existsSync(dest), true, "final file should exist on success");
    assertEquals(existsSync(partPath), false, "no .part scratch file should remain");
  } finally {
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset cleans up .part on digest mismatch", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const payload = new TextEncoder().encode("doesn't match the digest");
  const server = startServer(() => new Response(payload));
  const dest = join(tmp, "mismatch.bin");
  const partPath = `${dest}.part`;
  const wrongDigest = "0".repeat(64);

  try {
    await assertRejects(
      () =>
        fetchDataset({
          url: `http://localhost:${server.port}/x`,
          path: dest,
          sha256: wrongDigest,
        }),
      Error,
      "digest",
    );
    assertEquals(existsSync(dest), false, "final file must not exist on digest mismatch");
    assertEquals(existsSync(partPath), false, "scratch .part file must be removed");
  } finally {
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset rejects non-https schemes to prevent SSRF", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const dest = join(tmp, "blocked.bin");

  try {
    // file:// is the textbook SSRF/local-file disclosure target.
    await assertRejects(
      () => fetchDataset({ url: "file:///etc/passwd", path: dest }),
      Error,
      "https",
    );
    // ftp:// is also off-limits.
    await assertRejects(
      () => fetchDataset({ url: "ftp://example.com/x", path: dest }),
      Error,
      "https",
    );
    // Plain http on a public host is rejected (only loopback http is
    // tolerated for testing convenience).
    await assertRejects(
      () => fetchDataset({ url: "http://example.com/x", path: dest }),
      Error,
      "https",
    );
    assertEquals(existsSync(dest), false, "no file should be written for a rejected URL");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset rejects private and link-local hosts to prevent SSRF", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const dest = join(tmp, "blocked.bin");
  const blocked = [
    // AWS / GCP / Azure metadata service.
    "https://169.254.169.254/latest/meta-data/",
    // RFC1918 private networks.
    "https://10.0.0.1/x",
    "https://192.168.1.1/x",
    "https://172.16.0.1/x",
    // IPv6 link-local / unique-local.
    "https://[fe80::1]/x",
    "https://[fc00::1]/x",
    // GCP metadata DNS alias.
    "https://metadata.google.internal/x",
  ];

  try {
    for (const url of blocked) {
      await assertRejects(
        () => fetchDataset({ url, path: dest }),
        Error,
        "private",
        `expected ${url} to be rejected as a private/link-local target`,
      );
    }
    assertEquals(existsSync(dest), false, "no file should be written for a rejected URL");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset rejects malformed URLs without invoking fetch", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const dest = join(tmp, "blocked.bin");

  try {
    await assertRejects(
      () => fetchDataset({ url: "not a url", path: dest }),
      Error,
      "invalid URL",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset refuses to follow redirects", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const dest = join(tmp, "redirected.bin");
  // A redirect to an arbitrary host is the classic SSRF bypass: the
  // caller supplies a legitimate-looking URL, but the server hands back
  // a 302 to a private/internal target. We require the helper to refuse
  // rather than transparently follow.
  const server = startServer(() =>
    new Response("redirecting", {
      status: 302,
      headers: { Location: "http://169.254.169.254/" },
    })
  );

  try {
    await assertRejects(
      () =>
        fetchDataset({
          url: `http://localhost:${server.port}/redir`,
          path: dest,
        }),
      Error,
    );
    assertEquals(existsSync(dest), false, "no file should be written when a redirect is refused");
  } finally {
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset honours a matching digest as a cache hit", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const payload = new TextEncoder().encode("digest-match");
  const hash = await crypto.subtle.digest("SHA-256", payload);
  const expectedDigest = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const server = startServer(() => new Response(payload));
  const dest = join(tmp, "digest.bin");

  try {
    await fetchDataset({
      url: `http://localhost:${server.port}/x`,
      path: dest,
      sha256: expectedDigest,
    });
    await fetchDataset({
      url: `http://localhost:${server.port}/x`,
      path: dest,
      sha256: expectedDigest,
    });

    assertEquals(server.count, 1, "second call should not re-download when digest matches");
  } finally {
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset reports cumulative bytes written via onProgress", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const chunks = ["alpha", "beta", "gamma"].map((s) => new TextEncoder().encode(s));
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const server = startServer(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    )
  );
  const dest = join(tmp, "progress.bin");
  const seen: number[] = [];

  try {
    await fetchDataset({
      url: `http://localhost:${server.port}/x`,
      path: dest,
      onProgress: (bytesWritten) => seen.push(bytesWritten),
    });

    assertEquals(seen.length > 0, true, "onProgress should be called at least once");
    assertEquals(seen.at(-1), total, "the last report should be the total byte count");
    assertEquals(
      seen.every((v, i) => i === 0 || v > seen[i - 1]),
      true,
      `reports should increase monotonically, got ${JSON.stringify(seen)}`,
    );
    assertEquals(Deno.statSync(dest).size, total, "the final file should hold every byte");
  } finally {
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset does not call onProgress when the URL is rejected", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const dest = join(tmp, "never.bin");
  let calls = 0;

  try {
    await assertRejects(
      () =>
        fetchDataset({
          url: "file:///etc/passwd",
          path: dest,
          onProgress: () => calls++,
        }),
      Error,
      "https",
    );
    assertEquals(calls, 0, "no bytes are written, so no progress should be reported");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset fails over when a mirror never sends a response", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const payload = new TextEncoder().encode("from the responsive mirror");
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  // Accepts the connection but holds the response until the test ends.
  const hung = startServer(async () => {
    await released;
    return new Response("too late");
  });
  const working = startServer(() => new Response(payload));
  const dest = join(tmp, "hung.bin");

  try {
    await fetchDataset({
      url: [
        `http://localhost:${hung.port}/x`,
        `http://localhost:${working.port}/x`,
      ],
      path: dest,
      timeoutMs: 50,
    });

    assertEquals(await Deno.readFile(dest), payload);
    assertEquals(working.count, 1, "the responsive mirror should be used");
  } finally {
    release();
    await hung.stop();
    await working.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset fails over when a mirror stalls mid-body", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const payload = new TextEncoder().encode("complete payload");
  let stalledStream: ReadableStreamDefaultController<Uint8Array> | undefined;
  // Sends one chunk, then goes silent without closing the stream.
  const stalling = startServer(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stalledStream = controller;
          controller.enqueue(new TextEncoder().encode("partial"));
        },
      }),
    )
  );
  const working = startServer(() => new Response(payload));
  const dest = join(tmp, "stall.bin");

  try {
    await fetchDataset({
      url: [
        `http://localhost:${stalling.port}/x`,
        `http://localhost:${working.port}/x`,
      ],
      path: dest,
      timeoutMs: 50,
    });

    assertEquals(await Deno.readFile(dest), payload, "no stalled bytes may leak in");
    assertEquals(existsSync(`${dest}.part`), false, "scratch file should be removed");
  } finally {
    try {
      stalledStream?.close();
    } catch {
      // The server may already have cancelled the stream.
    }
    await stalling.stop();
    await working.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset names the timeout when the only mirror hangs", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const hung = startServer(async () => {
    await released;
    return new Response("too late");
  });

  try {
    await assertRejects(
      () =>
        fetchDataset({
          url: `http://localhost:${hung.port}/x`,
          path: join(tmp, "never.bin"),
          timeoutMs: 50,
        }),
      Error,
      "no data received for 50 ms",
    );
  } finally {
    release();
    await hung.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset rejects a non-positive timeout before any network I/O", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "data_cache_test_" });
  const server = startServer(() => new Response("unused"));
  try {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assertRejects(
        () =>
          fetchDataset({
            url: `http://localhost:${server.port}/x`,
            path: join(tmp, "x.bin"),
            timeoutMs,
          }),
        Error,
        "timeoutMs",
      );
    }
    assertEquals(server.count, 0, "an invalid timeout must fail before fetching");
  } finally {
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset keeps a slow download that never stalls", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const chunk = new TextEncoder().encode("trickle;");
  const chunks = 8;
  // Each gap is well inside the timeout, but the whole body outlasts it.
  const gapMs = 25;
  const timeoutMs = 150;
  const server = startServer(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 0; i < chunks; i++) {
            await new Promise((resolve) => setTimeout(resolve, gapMs));
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }),
    )
  );
  const dest = join(tmp, "slow.bin");

  try {
    await fetchDataset({ url: `http://localhost:${server.port}/x`, path: dest, timeoutMs });
    assertEquals((await Deno.readFile(dest)).byteLength, chunk.byteLength * chunks);
  } finally {
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

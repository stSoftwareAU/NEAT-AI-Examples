/**
 * Shared dataset cache helper for NEAT-AI examples.
 *
 * Examples that train on real-world data (e.g. MNIST, stock prices) should
 * not bloat the repository with raw datasets. Instead, they call
 * `fetchDataset` to download the file into a hidden working directory the
 * first time it is needed, and reuse it on subsequent runs.
 *
 * The helper:
 *   - Skips the download when the file already exists (and, when an
 *     expected SHA-256 digest is supplied, when the on-disk digest matches).
 *   - Streams the response body to disk so large files do not need to be
 *     buffered in memory. Bytes are written to a sibling `<path>.part`
 *     scratch file and only renamed onto the final path after the body
 *     has been fully received (and the SHA-256 digest verified, when one
 *     is supplied). This keeps the cache atomic — a process kill or full
 *     disk during the download cannot leave a truncated file at the
 *     final path that a later run would mistake for a cache hit.
 *   - Verifies the digest after writing and deletes the scratch file on
 *     mismatch so the next call can retry cleanly.
 *   - Tries each mirror URL in turn so a 404 or transient network failure
 *     on one mirror falls back to the next.
 *
 * Implementation uses Deno's built-in `fetch` and `crypto.subtle` — no
 * extra dependencies are required.
 */

import { ensureDir } from "@std/fs";
import { dirname } from "@std/path";

/** Options for {@link fetchDataset}. */
export interface FetchDatasetOptions {
  /** A single URL or a list of mirror URLs to try in order */
  url: string | string[];
  /**
   * Destination file path on disk. Parent directories are created
   * automatically. Examples typically place this under a hidden directory
   * such as `.synthetic-mnist/data/train.csv`.
   */
  path: string;
  /**
   * Optional lowercase hex-encoded SHA-256 digest of the expected file
   * contents. When supplied, the helper verifies the digest after writing
   * and rejects on mismatch. Cache hits also re-validate against this
   * digest before being trusted.
   */
  sha256?: string;
}

/**
 * Hosts on which plain `http://` is tolerated. These are loopback
 * addresses that cannot be used to reach an internal network from the
 * machine running the helper, so they are safe targets for the
 * in-process test server used by `data_cache_test.ts`.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Returns `true` when `hostname` is a literal IPv4/IPv6 address (or DNS
 * alias) that points at a private, link-local, or cloud-metadata target.
 * Used to block server-side request forgery (SSRF) against AWS / GCP /
 * Azure instance-metadata services and RFC1918 networks even when the
 * caller used `https://`.
 *
 * Note: this is best-effort literal-IP filtering. It cannot stop a
 * malicious DNS name that resolves to a private address — callers must
 * still pin URLs to trusted hosts (and ideally verify a SHA-256 digest).
 */
function isPrivateOrBlockedHost(hostname: string): boolean {
  // WHATWG `URL.hostname` wraps IPv6 literals in `[...]`; strip them so
  // the regexes below see the bare address.
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4 link-local — covers AWS / GCP / Azure instance metadata
  // (169.254.169.254) and the wider 169.254.0.0/16 range.
  if (/^169\.254\./.test(h)) return true;
  // IPv4 loopback range other than the explicit `127.0.0.1` allowlisted
  // above is treated as private.
  if (/^127\./.test(h) && h !== "127.0.0.1") return true;
  // RFC1918 private networks.
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
  // IPv6 link-local (`fe80::/10`).
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return true;
  // IPv6 unique-local (`fc00::/7`).
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true;
  // Well-known cloud-metadata DNS aliases.
  if (h === "metadata.google.internal" || h === "metadata.goog") return true;
  return false;
}

/**
 * Validates a caller-supplied URL string and returns the parsed `URL`.
 *
 * Throws when the URL is malformed, uses a non-https scheme (loopback
 * `http://` is the only exception, to keep the in-process test server
 * working), or points at a private/link-local/metadata host.
 */
function validateUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`fetchDataset: invalid URL "${raw}"`);
  }
  // Strip IPv6 brackets — `new URL("https://[::1]/")` returns `[::1]`
  // as the hostname under WHATWG.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLoopback = LOOPBACK_HOSTS.has(host);
  if (url.protocol === "http:") {
    if (!isLoopback) {
      throw new Error(
        `fetchDataset: refusing insecure URL "${raw}" — ` +
          `only https:// URLs are allowed (http:// is tolerated only for loopback hosts)`,
      );
    }
  } else if (url.protocol !== "https:") {
    throw new Error(
      `fetchDataset: refusing URL "${raw}" with unsupported scheme ` +
        `"${url.protocol}" — only https:// is allowed`,
    );
  }
  if (!isLoopback && isPrivateOrBlockedHost(host)) {
    throw new Error(
      `fetchDataset: refusing URL "${raw}" — host "${host}" is a ` +
        `private, link-local, or cloud-metadata address`,
    );
  }
  return url;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return false;
    }
    throw err;
  }
}

async function computeSha256(path: string): Promise<string> {
  const data = await Deno.readFile(path);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }
}

/**
 * Downloads a dataset file with on-disk caching and optional integrity
 * verification.
 *
 * Returns the destination path on success. Throws an `Error` with a
 * message that lists every attempted URL when no mirror succeeds, and
 * a digest-mismatch error (with the partial file removed) when the
 * downloaded bytes do not match the expected SHA-256.
 *
 * **Security — URL provenance.** Callers must supply URLs from a
 * trusted source: hard-coded constants, a digest-pinned manifest, or a
 * value the caller has otherwise validated. Do **not** pass an
 * unvalidated `Deno.args` argument, environment variable, or
 * user-supplied config field straight into this helper.
 *
 * The helper enforces several defences against server-side request
 * forgery (SSRF) regardless, but they are not a substitute for
 * verifying URL provenance:
 *
 * - Only `https://` URLs are accepted (plain `http://` is tolerated
 *   only against loopback hosts for in-process test servers).
 * - Schemes other than `http`/`https` — most importantly `file://`,
 *   `ftp://`, and `data:` — are rejected outright.
 * - Literal-IP hostnames in RFC1918 private ranges (10/8, 192.168/16,
 *   172.16/12), the IPv4 link-local range (169.254/16, where the AWS /
 *   GCP / Azure instance-metadata services live), IPv6 link-local
 *   (`fe80::/10`), IPv6 unique-local (`fc00::/7`), and the
 *   `metadata.google.internal` DNS alias are rejected.
 * - `fetch` is invoked with `redirect: "error"` so a 3xx response is
 *   reported as a per-URL failure rather than transparently followed —
 *   that closes the redirect-to-internal-host bypass.
 * - Always also supply `sha256` when downloading from a third-party
 *   mirror so a compromised mirror cannot substitute the bytes.
 */
export async function fetchDataset(opts: FetchDatasetOptions): Promise<string> {
  const { path } = opts;
  const expectedDigest = opts.sha256?.toLowerCase();
  const urls = Array.isArray(opts.url) ? opts.url : [opts.url];

  if (urls.length === 0) {
    throw new Error("fetchDataset: at least one URL must be provided");
  }

  // Validate every supplied URL up-front so a malformed or unsafe entry
  // fails fast — before any network I/O or scratch-file creation —
  // rather than after a partial cache write.
  for (const url of urls) {
    validateUrl(url);
  }

  // Cache hit? Optionally re-validate against the expected digest.
  if (await fileExists(path)) {
    if (!expectedDigest) {
      return path;
    }
    const onDisk = await computeSha256(path);
    if (onDisk === expectedDigest) {
      return path;
    }
    // Stale or corrupt cache entry — remove and re-download.
    await removeIfPresent(path);
  }

  await ensureDir(dirname(path));

  const errors: string[] = [];
  for (const url of urls) {
    let response: Response;
    try {
      // `redirect: "error"` turns any 3xx into a fetch error, blocking
      // the classic SSRF bypass where a legitimate host redirects to a
      // private / metadata target. Callers that genuinely need to follow
      // a redirect should resolve it themselves and pass the final URL.
      response = await fetch(url, { redirect: "error" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${url}: ${message}`);
      continue;
    }

    if (!response.ok) {
      // Drain the body so the connection can be released.
      try {
        await response.body?.cancel();
      } catch {
        // ignore — best-effort cleanup
      }
      errors.push(`${url}: HTTP ${response.status} ${response.statusText}`.trim());
      continue;
    }

    if (!response.body) {
      errors.push(`${url}: response has no body`);
      continue;
    }

    // Stream to a sibling scratch file and only rename onto the final
    // path after the digest check passes. A process kill or full disk
    // mid-download leaves the scratch file behind, never a truncated
    // file at `path` that a later run would treat as a cache hit.
    const partPath = `${path}.part`;
    try {
      const file = await Deno.open(partPath, { write: true, create: true, truncate: true });
      await response.body.pipeTo(file.writable);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await removeIfPresent(partPath);
      errors.push(`${url}: ${message}`);
      continue;
    }

    if (expectedDigest) {
      const actual = await computeSha256(partPath);
      if (actual !== expectedDigest) {
        await removeIfPresent(partPath);
        throw new Error(
          `fetchDataset: digest mismatch for ${url} ` +
            `(expected ${expectedDigest}, got ${actual})`,
        );
      }
    }

    try {
      await Deno.rename(partPath, path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await removeIfPresent(partPath);
      errors.push(`${url}: rename failed: ${message}`);
      continue;
    }

    return path;
  }

  throw new Error(
    `fetchDataset: failed to download ${path} from ${urls.length} URL(s):\n` +
      errors.map((e) => `  - ${e}`).join("\n"),
  );
}

#!/bin/bash
# Download a release tarball, verify it against a pinned SHA-256, and extract a
# single binary from it (Issue #748).
#
# Pinning an upstream *version* constrains which release is fetched but says
# nothing about which bytes arrive: a GitHub release asset is mutable, so a
# maintainer — or anyone who compromises the upstream account — can delete and
# re-upload an asset under an existing tag. Comparing against a digest that is
# committed to this repository closes that gap; a substituted asset fails the
# job loudly instead of executing.
#
# The digest is pinned by the caller rather than read from an upstream
# checksums file on purpose: a checksums file served from the same origin as
# the tarball is compromised by the same attacker.
#
# Usage: install_verified_tool.sh <tarball-url> <sha256> <binary> [dest-dir]

set -euo pipefail

usage() {
  echo "usage: $0 <tarball-url> <expected-sha256> <binary-name> [dest-dir]" >&2
  exit 2
}

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  usage
fi

url="$1"
expected="$2"
binary="$3"
dest_dir="${4:-.}"

# Reject anything that is not a bare 64-character lowercase hex digest, so an
# empty variable or a truncated paste can never be mistaken for a match.
case "${expected}" in
*[!0-9a-f]* | "") echo "Expected SHA-256 must be 64 lowercase hex characters: '${expected}'" >&2
  exit 2 ;;
esac
if [ "${#expected}" -ne 64 ]; then
  echo "Expected SHA-256 must be 64 lowercase hex characters: '${expected}'" >&2
  exit 2
fi

# Allowlist the archive member so a crafted name cannot write outside dest_dir.
case "${binary}" in
"" | *[!A-Za-z0-9._-]* | .*) echo "Binary name must be a plain file name: '${binary}'" >&2
  exit 2 ;;
esac

# GNU coreutils ships sha256sum; macOS (used when running these tests locally)
# ships shasum instead.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

workdir="$(mktemp -d)"
# shellcheck disable=SC2317  # invoked indirectly by the EXIT trap
cleanup() { rm -rf "${workdir}"; }
trap cleanup EXIT

tarball="${workdir}/tool.tar.gz"
curl -sSfL --retry 3 --retry-delay 5 "${url}" -o "${tarball}"

actual="$(sha256_of "${tarball}")"
if [ "${actual}" != "${expected}" ]; then
  echo "SHA-256 mismatch for ${url}" >&2
  echo "  expected: ${expected}" >&2
  echo "  actual:   ${actual}" >&2
  exit 1
fi

# Extract into the scratch directory first: nothing lands in the workspace
# until the bytes have been proven to match the pin.
tar -xzf "${tarball}" -C "${workdir}" "${binary}"
mkdir -p "${dest_dir}"
mv "${workdir}/${binary}" "${dest_dir}/${binary}"
chmod +x "${dest_dir}/${binary}"

echo "Verified ${binary} from ${url} (sha256 ${expected})"

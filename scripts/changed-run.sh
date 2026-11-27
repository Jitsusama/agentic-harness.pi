#!/usr/bin/env bash
# Runs a change's checks where `nix-offload there --run` checked the
# commit out, on a lent builder, as scripts/changed-words.sh's words
# start it, so the keeper keeps the pass at that commit and
# scripts/ready-gate.sh can read it (1JQPPC, 27 November):
#
#   scripts/changed-run.sh [FILE...]
#
# The files are the ones the change touched, since the lender's checkout
# holds no origin/main to diff against. It runs what `pnpm check` runs
# but for the browser lane, which needs a Chrome no lender has: lint,
# typecheck, knip, the package rules, the tests the files reach
# (`vitest related`, the files' own tests among them) and the load
# check. node, pnpm and git come from nixpkgs and the dependencies from
# the network, there: the work tool's tests need a git whose merge-file
# takes --object-id, which a lender's own git may not.
set -euo pipefail

if [[ -z ${CHANGED_RUN_INSIDE:-} ]]; then
  CHANGED_RUN_INSIDE=1 exec nix shell nixpkgs#nodejs_24 nixpkgs#pnpm nixpkgs#git nixpkgs#glibc.bin -c \
    bash "$0" "$@"
fi

pnpm install --frozen-lockfile > /dev/null 2>&1 || pnpm install --frozen-lockfile

# On NixOS npm's prebuilt biome finds only nix-ld's stub loader, which
# runs nothing without nix-ld set up, so it runs through glibc's own, the
# one ldd names, as scripts/check-there.sh runs it.
if [[ -e /etc/NIXOS ]]; then
  ld=""
  for each in $(sed -n 's/^RTLDLIST="\(.*\)"$/\1/p' "$(command -v ldd)"); do
    if [[ $each == */ld-linux-x86-64.so.2 && -e $each ]]; then ld=$each; fi
  done
  biome=""
  for each in node_modules/.pnpm/@biomejs+cli-linux-x64@*/node_modules/@biomejs/cli-linux-x64/biome; do
    if [[ -e $each ]]; then biome=$PWD/$each; fi
  done
  if [[ -z $ld || -z $biome ]]; then
    echo "changed-run: no glibc loader or no biome here to run biome by" >&2
    exit 1
  fi
  wrapper=$(mktemp -d)/biome
  printf '#!/bin/sh\nexec %q %q "$@"\n' "$ld" "$biome" > "$wrapper"
  chmod +x "$wrapper"
  export BIOME_BINARY=$wrapper
fi

pnpm lint
pnpm typecheck
pnpm knip
pnpm exec vitest run tests/package --testTimeout=60000
if [[ $# -gt 0 ]]; then
  pnpm exec vitest related --run --passWithNoTests "$@"
fi
pnpm load-check

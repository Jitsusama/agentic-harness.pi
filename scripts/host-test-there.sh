#!/usr/bin/env bash
# Runs `pnpm test:host` on a lent builder for the commit checked out where
# it is run, which may be any harness checkout (the install's copy serves a
# branch cut before this script was), on the proven pi-host runtime, and
# keeps what it said, so the merge gate (scripts/host-gate.sh) can let that
# commit merge. pnpm check skips the host cases wherever no runtime is
# installed, so before this nothing made a harness change pass them, and a
# merge that broke host/ reached every hosted conversation the next time a
# host started (OSPHT4, 10 November).
#
#   scripts/host-test-there.sh [FILE...]
#
# With no files it runs the whole of test:host, which is what the gate
# asks for. Given files, it runs only those, for a branch's own tests, and
# the gate doesn't count it. The runtime is the one the pi-host link names
# (PI_HOST_RUNTIME, else $XDG_STATE_HOME/pi-host/runtime), which only
# scripts/host-prove.ts moves, and only once test:host passed on it.
#
# It goes through `nix-offload there --run`, which sends the commit alone
# (it refuses uncommitted changes), the runtime and a few small tools from
# this machine's store; node and pnpm come from nixpkgs and the
# dependencies from the network, there. A run that sends node_modules
# from here costs a big upload on every new lockfile, and a derivation's
# sandbox gives the tests no network for the install. It keeps the run
# under $XDG_STATE_HOME/agentic-harness.pi/host-tests/<commit>/ and exits
# with the run's own status, or 75 when nothing ran, which keeps nothing.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"
state=${XDG_STATE_HOME:-$HOME/.local/state}
runtime=$(readlink -f "${PI_HOST_RUNTIME:-$state/pi-host/runtime}")
records=$state/agentic-harness.pi/host-tests
rev=$(git rev-parse HEAD)
# What nix-offload says when it ran nothing.
NOTHING_RAN=75

if [[ ! -d $runtime/lib/node_modules/pi-monorepo ]]; then
  echo "host-test-there: $runtime holds no pi-monorepo; prove a runtime with scripts/host-prove.ts first" >&2
  exit 2
fi
if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
  echo "host-test-there: $root has uncommitted changes, and only $rev would run; commit them first" >&2
  exit 2
fi

# Each tool's own store path, from what this machine runs. The lender has
# a shell, coreutils and git of its own, but not these: pi looks for fd and
# rg and says so in every case's output when they're gone, the attach
# tests run mycelium's client, and script(1) is taken from here so a run
# doesn't depend on the lender's util-linux.
copies=(--copy "$runtime")
path=""
for command in mycelium fd rg script; do
  found=$(command -v "$command" || true)
  if [[ -z $found ]]; then
    echo "host-test-there: $command isn't on PATH, and the run needs it" >&2
    exit 2
  fi
  store=$(readlink -f "$found" | cut -d/ -f1-4)
  copies+=(--copy "$store")
  path+="$store/bin:"
done
mycelium=$(readlink -f "$(command -v mycelium)")

if [[ $# -gt 0 ]]; then
  tests="pnpm exec vitest run --project process --reporter verbose $(printf '%q ' "$@")"
  # Seconds the lender may take: a few files, or the whole suite (about 20 minutes).
  longest=2400
else
  tests="pnpm test:host"
  longest=4200
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
echo "host-test-there: test:host at $rev on $runtime: $tests"
set +e
nix-offload there --never-ask --run "${copies[@]}" --longest "$longest" -- \
  nix shell nixpkgs#nodejs_24 nixpkgs#pnpm -c sh -c "
    set -e
    export PATH=$path\$PATH
    pnpm install --frozen-lockfile > /dev/null 2>&1 || pnpm install --frozen-lockfile
    PI_HOST_REQUIRED=1 PI_HOST_RUNTIME=$runtime MYCELIUM_BIN=$mycelium $tests" \
  2>&1 | tee "$scratch/log"
status=${PIPESTATUS[0]}
set -e
if [[ $status == "$NOTHING_RAN" ]]; then
  echo "host-test-there: nothing ran at $rev, so nothing is kept" >&2
  exit "$status"
fi

record=$records/$rev
rm -rf "$record.new"
mkdir -p "$record.new"
echo "$status" > "$record.new/status"
cp "$scratch/log" "$record.new/log"
echo "$runtime" > "$record.new/runtime"
if [[ $# -gt 0 ]]; then printf '%s\n' "$@" > "$record.new/files"; fi
rm -rf "$record"
mv "$record.new" "$record"

echo "host-test-there: test:host at $rev on $runtime exited $status; its log is $record/log"
exit "$status"

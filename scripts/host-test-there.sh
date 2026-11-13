#!/usr/bin/env bash
# Runs `pnpm test:host` on a lent builder for the commit checked out where
# it is run, which may be any harness checkout (the install's copy serves a
# branch cut before this script was), on the proven pi-host runtime, so the
# merge gate (scripts/host-gate.sh) can let that commit merge. pnpm check
# skips the host cases wherever no runtime is installed, so before this
# nothing made a harness change pass them, and a merge that broke host/
# reached every hosted conversation the next time a host started (OSPHT4,
# 10 November).
#
#   scripts/host-test-there.sh [FILE...]
#
# With no files it runs the whole of test:host, which is what the gate
# asks for. Given files, it runs only those, for a branch's own tests, and
# the gate doesn't count it. The runtime is the one the pi-host link names
# (PI_HOST_RUNTIME, else $XDG_STATE_HOME/pi-host/runtime), which only
# scripts/host-prove.ts moves, and only once test:host passed on it.
#
# It goes through `nix-offload there --run` with the words
# scripts/host-test-words.sh makes, which sends the commit alone (it
# refuses uncommitted changes), the runtime and a few small tools from this
# machine's store, and runs scripts/host-run.sh there. nix-offload keeps
# the pass itself, through its keeper, which the gate reads: nothing here
# writes a record, so none can be forged. Inside the agent fence the call
# can't reach a builder from in here, since the fence hides the builders'
# key, but the same call typed alone is let out: so there this prints it
# to run, and exits 75, as when nothing ran.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"
state=${XDG_STATE_HOME:-$HOME/.local/state}
runtime=$(readlink -f "${PI_HOST_RUNTIME:-$state/pi-host/runtime}")
rev=$(git rev-parse HEAD)
# What nix-offload says when it ran nothing.
NOTHING_RAN=75
# The builders' key, which the fence empties.
key=$HOME/.local/state/nix-offload/store_ed25519

if [[ ! -d $runtime/lib/node_modules/pi-monorepo ]]; then
  echo "host-test-there: $runtime holds no pi-monorepo; prove a runtime with scripts/host-prove.ts first" >&2
  exit 2
fi
if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
  echo "host-test-there: $root has uncommitted changes, and only $rev would run; commit them first" >&2
  exit 2
fi

# shellcheck source=host-test-words.sh
source "$(dirname "${BASH_SOURCE[0]}")/host-test-words.sh"
host_test_words "$runtime" "$@"

if [[ ! -s $key ]]; then
  echo "host-test-there: inside the agent fence, this can't reach a builder; run this, alone, as its own command:" >&2
  echo "cd $root && nix-offload there ${words[*]}"
  exit "$NOTHING_RAN"
fi

echo "host-test-there: test:host at $rev on $runtime"
set +e
nix-offload there "${words[@]}"
status=$?
set -e
if [[ $status == "$NOTHING_RAN" ]]; then
  echo "host-test-there: nothing ran at $rev" >&2
else
  echo "host-test-there: test:host at $rev on $runtime exited $status"
fi
exit "$status"

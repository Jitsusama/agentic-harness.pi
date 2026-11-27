#!/usr/bin/env bash
# Runs the checked-out commit's checks on a lent builder, the ones
# scripts/changed-run.sh says, so the keeper keeps the pass and
# review_offer ready, through scripts/ready-gate.sh, lets the change be
# marked ready at that very head:
#
#   bash scripts/changed-there.sh
#
# From a harness checkout whose HEAD is the commit, pushed or not: the
# lender is sent the commit itself. Inside the agent fence it can't reach
# a builder, so it prints the call to run alone instead, which the fence
# lets out, as scripts/host-test-there.sh does.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"
rev=$(git rev-parse HEAD)
# What nix-offload says when it ran nothing.
NOTHING_RAN=75
# The builders' key, which the fence empties.
key=$HOME/.local/state/nix-offload/store_ed25519

if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
  echo "changed-there: $root has uncommitted changes, and only $rev would run; commit them first" >&2
  exit 2
fi

# shellcheck source=changed-words.sh
source "$(dirname "${BASH_SOURCE[0]}")/changed-words.sh"
mapfile -t files < <(changed_files "$rev")
changed_words "${files[@]}"

if [[ ! -s $key ]]; then
  echo "changed-there: inside the agent fence, this can't reach a builder; run this, alone, as its own command:" >&2
  echo "cd $root && nix-offload there ${words[*]}"
  exit "$NOTHING_RAN"
fi

echo "changed-there: the checks of ${#files[@]} changed file(s) at $rev"
set +e
nix-offload there "${words[@]}"
status=$?
set -e
echo "changed-there: the checks at $rev exited $status"
exit "$status"

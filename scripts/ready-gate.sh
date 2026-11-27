#!/usr/bin/env bash
# The harness's ready gate, the `review.ready.gates` entry for
# github:Jitsusama/agentic-harness.pi that review_offer ready runs with
# the head's full commit, in a checkout of the repo:
#
#   bash ~/.local/share/pi-packages/github.com/Jitsusama/agentic-harness.pi/current/scripts/ready-gate.sh SHA
#
# A draft goes to its readers only once its checks passed at that very
# head (1JQPPC, 27 November): the keeper must have kept, as passed at
# SHA, the run scripts/changed-there.sh makes, its words exactly those
# scripts/changed-words.sh makes here for the files SHA changes. Only the
# keeper writes that record, so a fenced session can't forge one, and the
# keeper keeps any program that passed, so the words are what tell the
# checks from `true`. It reads; it runs no check, since a gate has
# minutes and the checks take longer. A refusal says the command that
# clears it.
set -euo pipefail

sha=${1:?Name the commit to mark ready: ready-gate.sh SHA}
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# What nix-offload says when this machine runs no keeper.
NO_KEEPER=69

# shellcheck source=changed-words.sh
source "$here/changed-words.sh"
mapfile -t files < <(changed_files "$sha")
changed_words "${files[@]}"
wanted=$(host_test_ran)

clear="Clear it from a harness checkout at $sha: bash $here/changed-there.sh"
set +e
ran=$(nix-offload passed ran "$sha")
kept=$?
set -e
if [[ $kept == "$NO_KEEPER" ]]; then
  echo "ready-gate: this machine runs no nix-offload keeper, so no run of the checks at $sha can be taken as passed. Mark it ready from a machine that runs one." >&2
  exit 1
elif [[ $kept != 0 ]]; then
  echo "ready-gate: nix-offload couldn't say what passed at $sha (it exited $kept). $clear, or ask again." >&2
  exit 1
elif grep -qF -- "$wanted" <<< "$ran"; then
  echo "ready-gate: the checks of ${#files[@]} changed file(s) passed at $sha"
  exit 0
fi
echo "ready-gate: no run of the checks of the ${#files[@]} file(s) $sha changes passed at $sha, on this machine's bash. $clear." >&2
exit 1

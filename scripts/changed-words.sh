# The words that run a change's checks on a lent builder, after
# `nix-offload there`, sourced by scripts/changed-there.sh, which runs
# them, and by scripts/ready-gate.sh, which takes only a pass the keeper
# kept for these very words at the head. Built as host-test-words.sh's
# are: every word plain, so the agent fence lets the call out, and the
# program the system's bash by its store path, so a gate working the
# words out again gets the same ones while the machine's bash hasn't
# moved.
#
# changed_files SHA prints, one a line and sorted, the files SHA changes
# since it left origin/main and still holds: a deleted file has no
# tests of its own to run, and typecheck finds what still imports it.
# changed_words FILE... fills the array `words`: the system's bash,
# copied up, then scripts/changed-run.sh at the commit with the files.
# shellcheck shell=bash

# shellcheck source=host-test-words.sh
source "$(dirname "${BASH_SOURCE[0]}")/host-test-words.sh"

# Seconds the lender may take: an install, lint, typecheck, knip, the
# package rules, the change's tests and the load check.
CHANGED_SECONDS=2400

changed_files() {
  local sha=$1 base
  base=$(git merge-base origin/main "$sha") || {
    echo "changed-words: $sha shares no history with origin/main here" >&2
    return 2
  }
  git diff --name-only --diff-filter=d --no-renames "$base" "$sha" | LC_ALL=C sort
}

changed_words() {
  local bash word
  bash=$(host_test_tool bash) || { echo "changed-words: no bash in the profiles" >&2; return 2; }
  words=(--never-ask --run --copy "$bash" --longest "$CHANGED_SECONDS"
    -- "$bash/bin/bash" scripts/changed-run.sh "$@")
  for word in "${words[@]}"; do
    if [[ ! $word =~ $HOST_TEST_PLAIN ]]; then
      echo "changed-words: $word isn't a plain word, which the agent fence won't let out" >&2
      return 2
    fi
  done
}

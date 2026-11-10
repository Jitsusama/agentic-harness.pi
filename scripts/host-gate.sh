#!/usr/bin/env bash
# The harness's merge gate for what pi hosts load. review_offer merge runs
# it with the head's full commit, from a checkout of the harness, as the
# `review.merge.gates` entry for github:Jitsusama/agentic-harness.pi:
#
#   bash ~/.local/share/pi-packages/github.com/Jitsusama/agentic-harness.pi/current/scripts/host-gate.sh
#
# A change that touches nothing a host runs merges as before. One that does
# merges only once scripts/host-test-there.sh has run the whole of
# `pnpm test:host` at that very commit, on the runtime the hosts are proven
# on, and every case passed. pnpm check can't stand in: it skips the host
# cases wherever no runtime is installed. The gate only reads what that run
# kept, since review_offer gives a gate five minutes and a run takes longer.
# A refusal says the command that clears it.
set -euo pipefail

sha=${1:?Name the commit to merge: host-gate.sh SHA}
state=${XDG_STATE_HOME:-$HOME/.local/state}
runtime=$(readlink -f "${PI_HOST_RUNTIME:-$state/pi-host/runtime}")
record=$state/agentic-harness.pi/host-tests/$sha

# What a host runs, and what decides how test:host runs it: the host
# program, its screens and the session seam its conversations go through,
# the host tests themselves, and the lockfile and config they run under.
hosted='^(host/|lib/ui/|lib/core/session/|lib/core/viewer/|tests/host/|scripts/pi-host|scripts/host-|package\.json$|pnpm-lock\.yaml$|vitest\.config\.ts$)'

git fetch -q origin main
if ! git cat-file -e "$sha^{commit}" 2> /dev/null; then git fetch -q origin "$sha"; fi
base=$(git merge-base origin/main "$sha")
touched=$(git diff --name-only "$base" "$sha" | grep -E "$hosted" || true)
if [[ -z $touched ]]; then
  echo "host-gate: $sha touches nothing pi hosts run, so test:host isn't needed"
  exit 0
fi

why=""
if [[ ! -f $record/status ]]; then
  why="nothing ran test:host at $sha"
elif [[ -e $record/files ]]; then
  why="test:host ran only some files at $sha"
elif [[ $(< "$record/runtime") != "$runtime" ]]; then
  why="test:host ran at $sha on $(< "$record/runtime"), not the proven $runtime"
elif [[ $(< "$record/status") != 0 ]]; then
  why="test:host at $sha exited $(< "$record/status"); its log is $record/log"
fi
if [[ -z $why ]]; then
  echo "host-gate: test:host passed at $sha on $runtime"
  exit 0
fi

count=$(echo "$touched" | wc -l)
echo "host-gate: $sha changes $count path(s) pi hosts run, such as $(echo "$touched" | head -n 1), and $why." >&2
echo "Clear it from a harness checkout: git checkout $sha && bash scripts/host-test-there.sh" >&2
exit 1

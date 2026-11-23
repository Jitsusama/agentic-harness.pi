#!/usr/bin/env bash
# The harness's merge gate for what pi hosts load. merge-gate.sh, the
# `review.merge.gates` entry for github:Jitsusama/agentic-harness.pi that
# review_offer merge runs, hands it the head's full commit once Biome has
# passed; run alone, it takes the same:
#
#   bash ~/.local/share/pi-packages/github.com/Jitsusama/agentic-harness.pi/current/scripts/host-gate.sh SHA
#
# A change that touches nothing a host runs merges as before. One that does
# merges only once scripts/host-test-there.sh has run the whole of
# `pnpm test:host` at that very commit, on the runtime the hosts are proven
# on, and every case passed. pnpm check can't stand in: it skips the host
# cases wherever no runtime is installed. The gate only reads what
# nix-offload's keeper kept of that run (`nix-offload passed ran SHA`),
# since review_offer gives a gate five minutes and a run takes longer. Only
# the keeper writes that record, so a fenced session can't forge one, and
# only a kept run whose words are exactly the ones host-test-words.sh makes
# here, from this machine's tools now or from a system generation it
# switched to in the last EARLIER_HOURS, counts: the keeper keeps any
# program that passed, true included. A refusal says the command that
# clears it.
set -euo pipefail

sha=${1:?Name the commit to merge: host-gate.sh SHA}
# The runner beside this gate, the install's when the install runs it: a
# branch's own copy can predate the runner the gate's records come from.
runner="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/host-test-there.sh"
state=${XDG_STATE_HOME:-$HOME/.local/state}
# A runtime link that names nothing would compare every run against a
# path no run was on, refusing each with a reason that hides the cause.
runtime_link=${PI_HOST_RUNTIME:-$state/pi-host/runtime}
if ! runtime=$(readlink -e "$runtime_link"); then
	echo "host-gate: the hosts' runtime link $runtime_link names nothing; switch the machine, or set PI_HOST_RUNTIME to the runtime the hosts are proven on" >&2
	exit 1
fi
# What nix-offload says when this machine runs no keeper.
NO_KEEPER=69
# How far back a system generation's tools still count. A run sends the
# tools the machine had as it started, and a switch while it runs, or
# before its merge, moves them on: at 11:26 on 15 November that voided four
# hour-long runs of commits nothing had changed. A run on any generation
# this machine switched to in these hours counts, since each was its real
# set of tools; the runtime the hosts are proven on must still match.
EARLIER_HOURS=12
# Where the machine's system generations are, each a system-N-link. Only
# root can add one there, so a generation's tools are ones the machine
# really switched to; its per-user tools are read from the generation's
# own closure, never from the account's profiles, which any agent of the
# account could write, and its age is the link's own (ISXEG8, 15
# November). A folder this account could write is taken as none.
generations=${HOST_GATE_GENERATIONS:-/nix/var/nix/profiles}

# What a host runs, and what decides how test:host runs it: the host
# program, its screens and the session seam its conversations go through,
# the host tests themselves, and the lockfile, config and setup they run
# under: the process lane's setup files, its global setup and the
# scripts' loader, never the unit lane's alone.
hosted='^(host/|lib/ui/|lib/core/session/|lib/core/viewer/|tests/host/|tests/setup/(pi-install|xdg-sandbox|temp-root|scripts-as-text)\.ts$|scripts/pi-host|scripts/host-|package\.json$|pnpm-lock\.yaml$|vitest\.config\.ts$)'
# The extensions whose tools and turns the host cases drive, and the
# libraries under them: background jobs, tool_search's loadout, the mesh,
# parking, quests, reloads, stored results, spend and subagents. A host
# loads every extension, but pnpm check's load check already proves the
# rest load; only these have behaviour a host case would catch. #1441
# changed subagent-workflow and merged with no run, breaking 3 cases.
driven='^(extensions/(job|loadout|mesh|park|quest|reload|result-store|spend|subagent)-workflow/|lib/(mesh|jobs|subagent)/|lib/internal/(session|reload|quest)/)'
# A folder's README, which says what the folder holds for a person and
# which nothing a host runs reads. Counting one asked a whole run, over an
# hour on a lender, of a change to prose alone: #1973 and #2002 on 22
# November each waited on one for a README line. Any other markdown still
# counts, since a host could read it.
prose='(^|/)README\.md$'

git fetch -q origin main
if ! git cat-file -e "$sha^{commit}" 2> /dev/null; then git fetch -q origin "$sha"; fi
base=$(git merge-base origin/main "$sha")
# The diff is its own step, so a diff that fails stops the gate rather
# than passing as a change that touches nothing. A rename is listed as
# the path it left and the path it took, so hosted code moved to a README
# still counts by the path it left.
changed=$(git diff --name-only --no-renames "$base" "$sha")
# A grep finding nothing exits 1, which means nothing a host runs; any
# other failure stops the gate rather than passing the change.
touched=$(echo "$changed" | grep -E "$hosted|$driven" | grep -vE "$prose") || [[ $? == 1 ]]
if [[ -z $touched ]]; then
  echo "host-gate: $sha touches nothing pi hosts run, so test:host isn't needed"
  exit 0
fi

# shellcheck source=host-test-words.sh
source "$(dirname "${BASH_SOURCE[0]}")/host-test-words.sh"
host_test_words "$runtime"
wanted=$(host_test_ran)

why=""
clear="Clear it from a harness checkout of $sha: bash $runner, or inside the agent fence the command it prints"
set +e
ran=$(nix-offload passed ran "$sha")
kept=$?
set -e
if [[ $kept == "$NO_KEEPER" ]]; then
  why="this machine runs no nix-offload keeper, so no run of test:host can be taken as passed"
  clear="Merge it from a machine that runs one"
elif [[ $kept != 0 ]]; then
  why="nix-offload couldn't say what passed at $sha (it exited $kept)"
elif [[ -z $ran ]]; then
  why="nothing ran test:host at $sha and passed"
elif grep -qF -- "$wanted" <<< "$ran"; then
  echo "host-gate: test:host passed at $sha on $runtime"
  exit 0
else
  # The newest first, so the answer names the latest set that matched.
  if [[ -w $generations ]]; then generations=""; fi
  while read -r link; do
    profiles="$link/etc/profiles/per-user/${USER:-}/bin:$link/sw/bin"
    HOST_TEST_PROFILES=$profiles host_test_words "$runtime" 2> /dev/null || continue
    if grep -qF -- "$(host_test_ran)" <<< "$ran"; then
      number=${link##*/system-}
      echo "host-gate: test:host passed at $sha on $runtime, on the tools of this machine's system generation ${number%-link}"
      exit 0
    fi
  done < <([[ -n $generations ]] && find "$generations" -maxdepth 1 -name 'system-*-link' -newermt "-$EARLIER_HOURS hours" 2> /dev/null |
    awk -F'system-' '{ n = $NF; sub(/-link$/, "", n); print n "\t" $0 }' | sort -nr | cut -f2-)
  why="what passed at $sha isn't test:host on the proven $runtime with this machine's tools, now or in the last $EARLIER_HOURS hours"
fi

count=$(echo "$touched" | wc -l)
echo "host-gate: $sha changes $count path(s) pi hosts run, such as $(echo "$touched" | head -n 1), and $why." >&2
echo "$clear." >&2
exit 1

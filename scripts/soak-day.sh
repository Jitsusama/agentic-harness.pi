#!/usr/bin/env bash
# Runs one day of the week's soak on lent builders, for the harness commit
# checked out where it is run, on the proven pi-host runtime, so a week of
# Joel's turns goes through one host before the host takes his sessions
# (plan item 10, OSPHT4, 14 November). A day is two runs, each held by its
# own lender: the volume run takes the day's share of a real week's turns
# unpaced, 20 conversations as tests/host/soak/week.ts cuts them, with
# bursts of wakes at each checkpoint, a planned restart mid-run, a wave
# of reloads onto a moved install and a restart at the end; the paced run takes 20 conversations of 4 turns at the week's
# real pace, which the latency bar is judged on, since unpaced turns all
# land in bursts.
#
#   scripts/soak-day.sh DAY OUT
#
# DAY is 1 to 7. Each run's lines go to OUT/<run>.log, and its report is
# cut into OUT/<run>/ (report.json, turns.json, wakes.json, figures.json,
# as tests/host/soak/day.mts says) with OUT/<run>/run.json naming the
# commit, the runtime, the arguments and how it ended. A lender sends back
# only what the soak printed, so nothing else comes home. It goes on to
# the paced run when the volume run fails, and exits with the first
# failure.
set -euo pipefail

day=${1:?soak-day.sh DAY OUT}
out=${2:?soak-day.sh DAY OUT}
root=$(git rev-parse --show-toplevel)
cd "$root"
state=${XDG_STATE_HOME:-$HOME/.local/state}
runtime=$(readlink -f "${PI_HOST_RUNTIME:-$state/pi-host/runtime}")
rev=$(git rev-parse HEAD)
# The longest a lender keeps one run, in seconds.
LONGEST=14400
# Checkpoints in a volume run: about three minutes each, so the day's
# weighings fill about 75 minutes of a lender's four hours.
VOLUME_CHECKPOINTS=24
# The week of 6 to 13 November's pace on optimus, as README.md says.
PACE=(--answer-ms 16007,38871 --tool-ms 541,12263 --rounds 7,55)
# The paced run's conversations, each of PACED_TURNS turns.
PACED_CONVERSATIONS=20
PACED_TURNS=4

if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
  echo "soak-day: $root has uncommitted changes, and only $rev would run; commit them first" >&2
  exit 2
fi
mkdir -p "$out"
turns=$(node --no-warnings tests/host/soak/day.mts turns "$day")
paced=$(printf "$PACED_TURNS,%.0s" $(seq "$PACED_CONVERSATIONS"))
paced=${paced%,}

# shellcheck source=host-test-words.sh
source "$(dirname "${BASH_SOURCE[0]}")/host-test-words.sh"
host_test_words "$runtime"
at=0
while [[ ${words[$at]} != -- ]]; do at=$((at + 1)); done
bash=${words[$((at + 1))]}
mycelium=${words[$((at + 4))]}
tools=${words[$((at + 5))]}
for i in "${!words[@]}"; do
  if [[ ${words[$i]} == --longest ]]; then words[$((i + 1))]=$LONGEST; fi
done

# Run the soak on a lender with the arguments after NAME, into OUT/NAME.
soak_there() {
  local name=$1
  shift
  local inner="export PATH=$tools:\$PATH; pnpm install --frozen-lockfile > /dev/null 2>&1 || pnpm install --frozen-lockfile; export PI_HOST_RUNTIME=$runtime MYCELIUM_BIN=$mycelium; unset PI_HOST_PACKAGE_DIR; exec node --no-warnings tests/host/soak/soak.mts $* --out soak-out"
  local started status
  started=$(date -u +%FT%TZ)
  echo "soak-day: day $day $name at $rev on $runtime: $*"
  set +e
  nix-offload there "${words[@]:0:$at}" -- "$bash" -c \
    "exec nix shell nixpkgs#nodejs_24 nixpkgs#pnpm -c $bash -c \"\$0\"" "$inner" \
    > "$out/$name.log" 2>&1
  status=$?
  node --no-warnings tests/host/soak/day.mts read "$out/$name.log" "$out/$name"
  set -e
  mkdir -p "$out/$name"
  printf '{"day":%s,"run":"%s","rev":"%s","runtime":"%s","args":"%s","started":"%s","ended":"%s","exit":%s}\n' \
    "$day" "$name" "$rev" "$runtime" "$*" "$started" "$(date -u +%FT%TZ)" "$status" \
    > "$out/$name/run.json"
  echo "soak-day: day $day $name exited $status"
  return "$status"
}

first=0
soak_there volume --turns "$turns" --checkpoints "$VOLUME_CHECKPOINTS" \
  --burst --restart-mid --reload-wave --restart || first=$?
soak_there paced --turns "$paced" --checkpoints 2 --burst "${PACE[@]}" \
  || { status=$?; [[ $first != 0 ]] || first=$status; }
exit "$first"

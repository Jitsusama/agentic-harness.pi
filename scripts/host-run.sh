#!/usr/bin/env bash
# Runs test:host where `nix-offload there --run` checked the commit out, on
# a lent builder, as scripts/host-test-words.sh's words start it: every
# word plain, so the agent fence lets the call out (it can't carry a shell
# script in quotes), with what the run needs named here instead.
#
#   scripts/host-run.sh RUNTIME MYCELIUM PATH [FILE...]
#
# RUNTIME is the proven pi-host runtime, MYCELIUM mycelium's client for
# the attach cases, and PATH the folders of the tools pi and the cases look
# for (mycelium, fd, rg and script(1)), all copied up from this machine.
# node and pnpm come from nixpkgs and the dependencies from the network,
# there. With files it runs only those, else the whole of test:host.
#
# A whole run prints vitest's JSON report last, between the two lines
# host/service/proof.ts names, since `nix-offload there --run` brings
# back only the output: scripts/host-prove.ts --report reads it out of
# the saved log, so a lender's run can prove a runtime (OSPHT4, 19
# November, when a loaded laptop failed two local proofs in a row).
set -euo pipefail

runtime=${1:?host-run.sh RUNTIME MYCELIUM PATH [FILE...]}
mycelium=${2:?host-run.sh RUNTIME MYCELIUM PATH [FILE...]}
tools=${3:?host-run.sh RUNTIME MYCELIUM PATH [FILE...]}
shift 3

if [[ -z ${HOST_RUN_INSIDE:-} ]]; then
  HOST_RUN_INSIDE=1 exec nix shell nixpkgs#nodejs_24 nixpkgs#pnpm -c \
    bash "$0" "$runtime" "$mycelium" "$tools" "$@"
fi

export PATH=$tools:$PATH
pnpm install --frozen-lockfile > /dev/null 2>&1 || pnpm install --frozen-lockfile
export PI_HOST_REQUIRED=1 PI_HOST_RUNTIME=$runtime MYCELIUM_BIN=$mycelium
# A lender runs nothing else, so its files run side by side, each sealing
# its host in folders of its own: one for each two cores, at most eight,
# the longest file bounding the run rather than their sum (4,259 s one at
# a time on 22 November, the longest 440 s). A laptop's lane, which sets
# none, stays one file at a time (vitest.config.ts, PROCESS_WORKERS).
MOST_WORKERS=8
if [[ -z ${PI_HOST_WORKERS:-} ]]; then
  PI_HOST_WORKERS=$(($(nproc) / 2))
  ((PI_HOST_WORKERS > MOST_WORKERS)) && PI_HOST_WORKERS=$MOST_WORKERS
  ((PI_HOST_WORKERS < 1)) && PI_HOST_WORKERS=1
fi
export PI_HOST_WORKERS
echo "host-run: $PI_HOST_WORKERS files at once on $(nproc) cores"
if [[ $# -gt 0 ]]; then
  exec pnpm exec vitest run --project process --reporter verbose "$@"
fi
report=$(mktemp)
# The suite runs as a child so its report can follow, and a stop that
# reaches this shell is passed on to it rather than leaving it running on
# the lender.
pnpm test:host --reporter=json "--outputFile.json=$report" &
suite=$!
trap 'kill -TERM "$suite" 2>/dev/null' TERM HUP INT
set +e
wait "$suite"
status=$?
# A stop interrupts the wait before the suite has ended; wait for its end.
while kill -0 "$suite" 2>/dev/null; do
  wait "$suite"
  status=$?
done
set -e
trap - TERM HUP INT
echo "host-run: vitest's report follows"
# A run that died before its report leaves the file empty, which proves
# nothing; the run's own exit is kept either way.
cat "$report" || true
echo
echo "host-run: vitest's report ends"
rm -f "$report"
exit "$status"

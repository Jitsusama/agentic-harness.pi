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
# its host in folders of its own: one for each two cores, which
# vitest.config.ts holds to at most eight (PROCESS_WORKERS). On 22
# November that ran the suite in 13 min 20 s on 32 cores, build included,
# against about 71 min one at a time, its longest file 422 s. A laptop's
# lane, which sets none, stays one file at a time. It says so on stderr,
# since what it prints on stdout is the suite's and the report's alone.
cores=$(nproc 2> /dev/null || echo 2)
export PI_HOST_WORKERS=${PI_HOST_WORKERS:-$((cores / 2))}
echo "host-run: $PI_HOST_WORKERS files at once asked for on $cores cores, of at most 8" >&2
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

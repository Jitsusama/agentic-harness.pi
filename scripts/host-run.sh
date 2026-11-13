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
if [[ $# -gt 0 ]]; then
  exec pnpm exec vitest run --project process --reporter verbose "$@"
fi
exec pnpm test:host

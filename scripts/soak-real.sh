#!/usr/bin/env bash
# Runs the soak's real-model slice on this machine, in sealed hosts of its
# own, beside a day of the week's soak (plan item 10, OSPHT4, 14 November):
# a few dozen turns a day on a real model through the AI proxy, where the
# real API refuses a conversation a host carried, parked or restored
# wrongly, which the script's model never would. It runs here, not on a
# lender: the proxy's key comes from this environment, as
# SHOPIFY_PROXY_KEY, and goes nowhere but each request's header to the
# proxy. A lender has no key and is never given one.
#
#   scripts/soak-real.sh MODEL OUT [SOAK ARGUMENTS...]
#
# MODEL is the proxy's model, claude-haiku-5-5 for the slice. The soak
# takes 4 conversations of 10 turns through a restart mid-run and one at
# the end unless arguments after OUT say otherwise. Its lines go to
# OUT/real.log and its report, cut into files, to OUT/real/, with
# OUT/real/run.json naming the commit, the runtime, the model, the
# arguments and how it ended. It waits while the machine's memory is
# under pressure, since a person's work comes first. Run it under
# systemd-run --user --scope, so nothing that restarts a session cuts it
# off.
set -euo pipefail

model=${1:?soak-real.sh MODEL OUT [SOAK ARGUMENTS...]}
out=${2:?soak-real.sh MODEL OUT [SOAK ARGUMENTS...]}
shift 2
args=("$@")
if [[ ${#args[@]} -eq 0 ]]; then
  args=(--turns 10,10,10,10 --checkpoints 2 --restart-mid --restart)
fi
# The share of the last minute every task waited on memory, in percent,
# past which the slice waits rather than add to it.
MOST_PRESSURE=3
# How long to wait between looks at the pressure, in seconds.
LOOK_EVERY=60
# How many looks before giving up, an hour of them.
MOST_LOOKS=60

if [[ -z ${SHOPIFY_PROXY_KEY:-} ]]; then
  echo "soak-real: SHOPIFY_PROXY_KEY isn't set; release it to this command, never to a file" >&2
  exit 2
fi
root=$(git rev-parse --show-toplevel)
cd "$root"
state=${XDG_STATE_HOME:-$HOME/.local/state}
runtime=$(readlink -f "${PI_HOST_RUNTIME:-$state/pi-host/runtime}")
mycelium=${MYCELIUM_BIN:-$(command -v mycelium)}
rev=$(git rev-parse HEAD)

pressure() {
  sed -n 's/^full avg10=[0-9.]* avg60=\([0-9]*\)\..*/\1/p' /proc/pressure/memory
}
looks=0
while (( $(pressure) >= MOST_PRESSURE )); do
  looks=$((looks + 1))
  if (( looks > MOST_LOOKS )); then
    echo "soak-real: memory stayed under pressure for an hour; nothing ran" >&2
    exit 75
  fi
  # Look again in a minute: nothing says when the pressure falls.
  sleep "$LOOK_EVERY"
done

mkdir -p "$out/real"
started=$(date -u +%FT%TZ)
echo "soak-real: $model at $rev on $runtime: ${args[*]}"
set +e
PI_HOST_RUNTIME=$runtime MYCELIUM_BIN=$mycelium \
  node --no-warnings tests/host/soak/soak.mts --real "$model" "${args[@]}" \
  --out "$out/real-out" > "$out/real.log" 2>&1
status=$?
node --no-warnings tests/host/soak/day.mts read "$out/real.log" "$out/real"
set -e
printf '{"run":"real","model":"%s","rev":"%s","runtime":"%s","args":"%s","started":"%s","ended":"%s","exit":%s}\n' \
  "$model" "$rev" "$runtime" "${args[*]}" "$started" "$(date -u +%FT%TZ)" "$status" \
  > "$out/real/run.json"
echo "soak-real: exited $status"
exit "$status"

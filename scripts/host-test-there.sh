#!/usr/bin/env bash
# Runs `pnpm test:host` for the commit checked out on a lent builder, on the
# proven pi-host runtime, and keeps what it said, so the merge gate
# (scripts/host-gate.sh) can let that commit merge. pnpm check skips the
# host cases wherever no runtime is installed, so before this nothing made
# a harness change pass them, and a merge that broke host/ reached every
# hosted conversation the next time a host started (OSPHT4, 10 November).
#
#   scripts/host-test-there.sh [FILE...]
#
# With no files it runs the whole of test:host, which is what the gate
# asks for. Given files, it runs only those, for a branch's own tests, and
# the gate doesn't count it. The runtime is the one the pi-host link names
# (PI_HOST_RUNTIME, else $XDG_STATE_HOME/pi-host/runtime), which only
# scripts/host-prove.ts moves, and only once test:host passed on it. The
# commit's files go up as `git archive` writes them, so nothing
# uncommitted rides along; node_modules go up once per pnpm-lock.yaml and
# are reused after. It keeps the run under
# $XDG_STATE_HOME/agentic-harness.pi/host-tests/<commit>/ and exits with
# the run's own status.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)
state=${XDG_STATE_HOME:-$HOME/.local/state}
runtime=$(readlink -f "${PI_HOST_RUNTIME:-$state/pi-host/runtime}")
records=$state/agentic-harness.pi/host-tests
rev=$(git -C "$root" rev-parse HEAD)

if [[ ! -d $runtime/lib/node_modules/pi-monorepo ]]; then
  echo "host-test-there: $runtime holds no pi-monorepo; prove a runtime with scripts/host-prove.ts first" >&2
  exit 2
fi
if [[ ! -d $root/node_modules ]]; then
  echo "host-test-there: $root has no node_modules; run pnpm install --frozen-lockfile first" >&2
  exit 2
fi

# Each tool's own store path, from what this machine runs, bash first. git
# is taken from where its own programs live, since the git on PATH can be a
# wrapper around it (World's is).
tools=()
gitCore=$(git --exec-path)
tools+=("$(echo "$gitCore" | cut -d/ -f1-4)")
# pi looks for fd and rg, and says so in every case's output when they're gone.
for command in node mycelium setsid systemd-notify ls grep sed find ps which diff fd rg; do
  found=$(command -v "$command" || true)
  if [[ -z $found ]]; then
    echo "host-test-there: $command isn't on PATH, and the run needs it" >&2
    exit 2
  fi
  real=$(readlink -f "$found")
  tools+=("$(echo "$real" | cut -d/ -f1-4)")
done
shell=$(readlink -f "$(command -v bash)" | cut -d/ -f1-4)
tools=("$shell" "${tools[@]}")

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/source"
git -C "$root" archive "$rev" | tar -x -C "$scratch/source"

# node_modules sent before for this lockfile, when the store still has it.
lock=$(sha256sum "$root/pnpm-lock.yaml" | cut -d' ' -f1)
known=$records/deps/$lock
deps=()
if [[ -s $known ]] && nix-store --check-validity "$(< "$known")" 2> /dev/null; then
  deps=(--argstr deps "$(< "$known")")
else
  deps=(--argstr modules "$root")
fi

scope=()
if [[ $# -gt 0 ]]; then
  list="["
  for file in "$@"; do list+=" \"$file\""; done
  scope=(--arg files "$list ]")
fi

toolList="["
for tool in "${tools[@]}"; do toolList+=" \"$tool\""; done
drv=$(nix-instantiate "$here/host-test.nix" --add-root "$scratch/drv" \
  --argstr runtime "$runtime" --argstr source "$scratch/source" --argstr rev "$rev" \
  --arg tools "$toolList ]" "${deps[@]}" "${scope[@]}")

mkdir -p "$records/deps"
nix derivation show "$drv" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const all=JSON.parse(s);const each=all.derivations??all;for(const d of Object.values(each)){if(d.env?.deps){console.log(d.env.deps.startsWith("/")?d.env.deps:`/nix/store/${d.env.deps}`);return}}})' \
  > "$records/deps/$lock.new"
mv "$records/deps/$lock.new" "$known"

out=$(nix-offload there -L --print-out-paths "$drv^*")
record=$records/$rev
rm -rf "$record.new"
mkdir -p "$record.new"
cp "$out/status" "$out/log" "$record.new/"
if [[ -e $out/report.json ]]; then cp "$out/report.json" "$record.new/"; fi
echo "$runtime" > "$record.new/runtime"
if [[ $# -gt 0 ]]; then printf '%s\n' "$@" > "$record.new/files"; fi
rm -rf "$record"
mv "$record.new" "$record"

status=$(< "$record/status")
echo "host-test-there: test:host at $rev on $runtime exited $status; its log is $record/log"
exit "$status"

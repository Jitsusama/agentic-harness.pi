#!/usr/bin/env bash
# Runs the whole `pnpm check` for a pushed branch on another machine, so a
# full check leaves the machine its author works on alone. On 8 November
# optimus's own checks took about 5,400 of its 8,800 job-minutes overnight
# while a deploy's lanes waited, and P9R1KI sent every whole check
# elsewhere; this is the one way every session sends it.
#
#   pnpm check:there [branch] [host]
#
# The branch defaults to the one checked out, which must be pushed as it
# stands; the host defaults to penelope. The host keeps a clone of its own
# under ~/.cache/harness-check.git, fetched from GitHub each time and
# checked out in a worktree of it at ~/.cache/harness-check-tree, so nothing
# of the person's on it is touched. It finds the pnpm that package.json
# names in its Nix store, since corepack can't fetch one there, and runs
# npm's prebuilt biome through glibc's own loader where the host has no
# nix-ld. Checks on one host take turns, since they share that worktree.
# Exits with what `pnpm check` exited with.
set -euo pipefail

branch="${1:-$(git rev-parse --abbrev-ref HEAD)}"
host="${2:-penelope}"

if [ "$#" -lt 1 ]; then
  git fetch -q origin "$branch"
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$branch")" ]; then
    echo "check-there: $branch differs from origin/$branch; push it first" >&2
    exit 2
  fi
fi

exec ssh -o BatchMode=yes "$host" bash -s -- "$branch" <<'THERE'
set -euo pipefail
branch="$1"
# The check runs in a worktree of a bare clone, as the harness's own trees
# are: the strict sandbox's tests refuse a plain clone's folder, whose git
# folder commands could write.
repo=~/.cache/harness-check.git
dir=~/.cache/harness-check-tree
# Every check checks its branch out into the one worktree, so a second
# started beside the first would swap the files under it. Each holds this
# lock from the fetch to the end of `pnpm check`, and a second waits.
mkdir -p ~/.cache
exec 9> ~/.cache/harness-check.lock
if ! flock -n 9; then
  echo "check-there: another check runs on $(hostname); waiting its turn" >&2
  flock 9
fi
if [ ! -d "$repo" ]; then
  git clone -q --bare https://github.com/Jitsusama/agentic-harness.pi.git "$repo"
fi
git -C "$repo" fetch -q origin "+refs/heads/$branch:refs/remotes/origin/$branch" "+refs/heads/main:refs/remotes/origin/main"
if [ ! -e "$dir/.git" ]; then
  git -C "$repo" worktree prune
  git -C "$repo" worktree add -q --detach "$dir" "origin/$branch"
fi
cd "$dir"
git checkout -q --force --detach "origin/$branch"
git log --oneline -1
want=$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' package.json)
bin=$(ls -d /nix/store/*-pnpm-"$want"/bin 2>/dev/null | head -1)
if [ -z "$bin" ]; then
  echo "check-there: no pnpm $want in $(hostname)'s store" >&2
  exit 1
fi
export PATH="$bin:$PATH"
pnpm install --frozen-lockfile --silent
# On NixOS a prebuilt binary finds only nix-ld's stub loader, which runs
# nothing without nix-ld set up, so biome is run through glibc's by hand.
if [ -e /etc/NIXOS ]; then
  ld=$(ls /nix/store/*-glibc-2.*/lib/ld-linux-x86-64.so.2 2>/dev/null | grep -v -- -bin | tail -1)
  real=$(ls -d node_modules/.pnpm/@biomejs+cli-linux-x64@*/node_modules/@biomejs/cli-linux-x64/biome | head -1)
  mkdir -p ~/.cache/harness-check-bin
  printf '#!/bin/sh\nexec %s %s "$@"\n' "$ld" "$PWD/$real" > ~/.cache/harness-check-bin/biome
  chmod +x ~/.cache/harness-check-bin/biome
  export BIOME_BINARY=~/.cache/harness-check-bin/biome
fi
pnpm check
THERE

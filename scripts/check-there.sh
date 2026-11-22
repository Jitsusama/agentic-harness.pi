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
# checked out in a worktree of it at ~/.local/state/harness-check-tree, so
# nothing of the person's on it is touched. The tree is kept out of any
# folder named .cache: Biome 2.5.3 skips its project scan there, so its
# project and type rules silently don't run (Y9XISP, 10 November).
# After `pnpm check` it runs tests/package, which the merge gate also
# holds a change to. It finds the pnpm that package.json
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

# ssh joins its words into one line the host's shell reads again, so the
# branch goes quoted: git lets a branch's name hold `;` and `$(`.
exec ssh -o BatchMode=yes "$host" "bash -s -- $(printf '%q' "$branch")" <<'THERE'
set -euo pipefail
branch="$1"
# The check runs in a worktree of a bare clone, as the harness's own trees
# are, so it reads the code as a session working on it does.
repo=~/.cache/harness-check.git
dir=~/.local/state/harness-check-tree
mkdir -p ~/.local/state
# Every check checks its branch out into the one worktree, so a second
# started beside the first would swap the files under it. Each holds this
# lock from the fetch to the end of `pnpm check`, and a second waits.
mkdir -p ~/.cache
# A shell ssh starts on a Mac finds no node, and pnpm 12 is one binary
# with its own node inside, so the check's scripts get the node 24 the
# harness's other scripts run on, from the host's nixpkgs. It is found
# before the lock, so no other check waits on a fetch, and linked from
# ~/.cache, so the store keeps it while the check runs.
if ! command -v node >/dev/null 2>&1; then
  if ! node=$(nix build --out-link ~/.cache/harness-check-node --print-out-paths nixpkgs#nodejs_24); then
    echo "check-there: no node on $(hostname), and nix gave none" >&2
    exit 1
  fi
  export PATH="$node/bin:$PATH"
fi
# flock(1) is util-linux's, which a Mac lacks, so there perl takes the
# same lock on fd 9's open file. A flock lock belongs to the open file,
# not the process, so it holds after perl exits, while this shell keeps
# fd 9 open. Given -n, it exits 1 at once when another holds the lock,
# and anything else but 0 when it couldn't try it, as flock(1) does.
lock() {
  if command -v flock >/dev/null 2>&1; then
    flock "$@" 9
    return
  fi
  perl -MFcntl=:flock -MPOSIX=EWOULDBLOCK -e '
    open(my $f, ">&=", 9) or do { print STDERR "check-there: fd 9: $!\n"; exit 2 };
    flock($f, $ARGV[0] eq "-n" ? LOCK_EX | LOCK_NB : LOCK_EX)
      or exit($! == EWOULDBLOCK ? 1 : 2);
  ' -- "${1:-}"
}
# Wait for the lock only while another check holds it; a lock that can't
# be tried fails the check, which would otherwise share the worktree.
take_turn() {
  local tried=0
  lock -n || tried=$?
  if [ "$tried" -eq 0 ]; then
    return
  fi
  if [ "$tried" -ne 1 ]; then
    echo "check-there: can't take $(hostname)'s check lock" >&2
    return "$tried"
  fi
  echo "check-there: another check runs on $(hostname); waiting its turn" >&2
  lock
}
exec 9> ~/.cache/harness-check.lock
take_turn
# Everything the check starts runs without fd 9, so nothing it leaves
# running, such as git's fsmonitor daemon, holds the lock once it ends.
{
if [ ! -d "$repo" ]; then
  git clone -q --bare https://github.com/Jitsusama/agentic-harness.pi.git "$repo"
fi
git -C "$repo" fetch -q origin "+refs/heads/$branch:refs/remotes/origin/$branch" "+refs/heads/main:refs/remotes/origin/main"
# The tree once sat under ~/.cache, where Biome skipped its project rules.
if [ -e ~/.cache/harness-check-tree/.git ]; then
  git -C "$repo" worktree remove --force ~/.cache/harness-check-tree
fi
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
pnpm exec vitest run tests/package --testTimeout=60000
} 9>&-
THERE

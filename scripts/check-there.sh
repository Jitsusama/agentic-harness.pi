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
# nix-ld. Checks on one host take turns, since they share that worktree;
# one waits at most CHECK_THERE_WAIT_S seconds (5400 by default) for the
# check before it to end, and its holder's line names the pid that stops
# the whole of a check with a TERM, its turn passing once its work has
# stopped. A check whose caller goes away runs on, since without a pty
# sshd signals nothing. Exits with what `pnpm check` exited with, or 75
# when its turn never came.
set -euo pipefail

branch="${1:-$(git rev-parse --abbrev-ref HEAD)}"
host="${2:-penelope}"
wait_s="${CHECK_THERE_WAIT_S:-5400}"
# A wait is at most seven digits, over a hundred days, so no slip of the
# keys asks for one that never ends.
case "$wait_s" in
  '' | *[!0-9]* | ????????*)
    echo "check-there: CHECK_THERE_WAIT_S is '$wait_s', not a number of seconds under ten million" >&2
    exit 2
    ;;
esac
# ssh joins its words into one line the host's login shell, bash or zsh,
# reads again, and git lets a branch's name hold `;` and `$(`, so a check
# takes only a branch named in plain characters. ssh would read a host
# that opens with a dash, or a name after its user that does, as one of
# its options, and an older ssh puts the name as it stands into a
# ProxyCommand's shell line.
case "$branch" in
  '' | -* | *[!A-Za-z0-9._/@+-]*)
    echo "check-there: '$branch' names no branch a check can take" >&2
    exit 2
    ;;
esac
case "$host" in
  -* | *@-* | *[!A-Za-z0-9._@-]*)
    echo "check-there: '$host' names no host" >&2
    exit 2
    ;;
esac

if [ "$#" -lt 1 ]; then
  git fetch -q origin "$branch"
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$branch")" ]; then
    echo "check-there: $branch differs from origin/$branch; push it first" >&2
    exit 2
  fi
fi

# The branch goes quoted all the same, should its characters ever widen.
exec ssh -o BatchMode=yes "$host" "bash -s -- $(printf '%q' "$branch") $wait_s" <<'THERE'
set -euo pipefail
# Each job this shell starts leads a process group of its own, so a stop
# reaches a check's work, and waits for all of it, without signalling
# this shell or the one ssh started it from.
set -m
branch="$1"
turn_wait_s="$2"
# The check runs in a worktree of a bare clone, as the harness's own trees
# are, so it reads the code as a session working on it does.
repo=~/.cache/harness-check.git
dir=~/.local/state/harness-check-tree
mkdir -p ~/.local/state
# Every check checks its branch out into the one worktree, so a second
# started beside the first would swap the files under it. Each holds this
# lock from the fetch to the end of `pnpm check`, and a second waits.
mkdir -p ~/.cache
# What a check leaves in ~/.cache is its own, and goes as it ends: the
# link that keeps its node, and the line saying it holds the turn, only
# once it has taken it, so a check that gave up leaves its holder's.
let_go() {
  if [ -n "${node_link:-}" ]; then rm -f "$node_link"; fi
  if [ -n "${holder:-}" ]; then rm -f "$holder"; fi
}
trap let_go EXIT
# A check stopped by the pid its holder's line names stops whole. Its
# work runs without fd 9, so the turn would pass while that work ran on
# in the shared worktree. So this shell sends a TERM to the group of
# each job it started, read from its own table rather than a name it
# sets after starting one, which a signal can land before; waits for
# them before it ends as signalled; and kills what is still there after
# `stop_wait_s` seconds. A command that leaves the group, as a detached
# test does, is not reached; and a KILL to this shell runs no trap, so
# its turn passes while its work runs on.
# Whether the groups $2 onward have all ended within $1 seconds, asked
# every tenth of one, since nothing says when a group's last member goes.
gone_within() {
  local tenths=$(( $1 * 10 )) group
  shift
  for group in "$@"; do
    while kill -0 -- "-$group" 2>/dev/null; do
      [ "$tenths" -gt 0 ] || return 1
      sleep 0.1
      tenths=$(( tenths - 1 ))
    done
  done
}
# Ends the groups named: a TERM, `stop_wait_s` seconds for them to go,
# then a KILL to what is left. Its return says 0 outright: in a trap, a
# bare one says what the command the trap landed in ended with.
end_groups() {
  local group
  for group in "$@"; do kill -TERM -- "-$group" 2>/dev/null || true; done
  gone_within "${stop_wait_s:-10}" "$@" && return 0
  for group in "$@"; do kill -KILL -- "-$group" 2>/dev/null || true; done
  gone_within 5 "$@" || true
}
stop_all() {
  trap '' TERM INT HUP
  local groups
  # The job alone is ending what it left is gone from the table already.
  groups="$(jobs -p) ${ending:-}"
  # shellcheck disable=SC2086 # one word a group
  end_groups $groups
  exit "$1"
}
trap 'stop_all 143' TERM
trap 'stop_all 130' INT
trap 'stop_all 129' HUP
# Runs a command as a job in a group of its own and without fd 9, and
# ends what it left in its group as it ends, so the turn passes with
# none of it running; what leaves the group, as git's fsmonitor daemon
# may, holds no lock as it runs on. A job under `set -m` keeps this
# shell's stdin, the script `bash -s` reads, so it gets none, and
# nothing in it can swallow the script. It is asked after every second
# rather than waited on, since a signal landing just as `wait` begins
# waits for the job's end; a trap runs as soon as the second's sleep
# ends. Work that would have no group of its own, as with job control
# off, is refused before it runs, since no stop could reach it; and one
# that runs without its group anyway is ended. The group is asked after
# first, since a job ending between the two asks has had a group.
alone() {
  case "$-" in
    *m*) ;;
    *)
      echo "check-there: $1 got no process group of its own, so no stop could reach it" >&2
      return 1
      ;;
  esac
  "$@" 9>&- </dev/null &
  local job=$! status=0
  if ! kill -0 -- "-$job" 2>/dev/null && kill -0 "$job" 2>/dev/null; then
    kill -KILL "$job" 2>/dev/null || true
    wait "$job" 2>/dev/null || true
    echo "check-there: $1 got no process group of its own, so no stop could reach it" >&2
    return 1
  fi
  while kill -0 "$job" 2>/dev/null; do sleep 1; done
  ending=$job
  wait "$job" || status=$?
  end_groups "$job"
  ending=
  return "$status"
}
# A check killed outright runs no trap, so its node link stays; each
# check takes away the links of checks no longer running.
let_go_of_dead() {
  local link
  for link in ~/.cache/harness-check-node.*; do
    [ -L "$link" ] || continue
    kill -0 "${link##*.}" 2>/dev/null || rm -f "$link"
  done
}
# A shell ssh starts on a Mac finds no node, and pnpm 12 is one binary
# with its own node inside, so the check's scripts get the node 24 the
# harness's other scripts run on, from the host's nixpkgs. It is found
# before the lock, so no other check waits on a fetch, and linked from
# ~/.cache under this check's own name, so the store keeps it while the
# check runs and a check started beside it can't repoint the link. The
# build runs alone, so a stop meanwhile reaches it; a substitution's
# shell would start it with no job control.
let_go_of_dead
if ! command -v node >/dev/null 2>&1; then
  node_link=~/.cache/harness-check-node.$$
  if ! alone nix build --out-link "$node_link" nixpkgs#nodejs_24; then
    echo "check-there: no node on $(hostname), and nix gave none" >&2
    exit 1
  fi
  export PATH="$node_link/bin:$PATH"
fi
# flock(1) is util-linux's, which a Mac lacks, so there perl takes the
# same lock on fd 9's open file. A flock lock belongs to the open file,
# not the process, so it holds after perl exits, while this shell keeps
# fd 9 open. `lock -n` tries once and `lock -w SECONDS` waits that long;
# each exits 1 while another holds the lock, and anything else but 0
# when it couldn't try it, as flock(1) does.
lock() {
  if command -v flock >/dev/null 2>&1; then
    flock "$@" 9
    return
  fi
  perl -MFcntl=:flock -MPOSIX=EWOULDBLOCK -e '
    open(my $f, ">&=", 9) or do { print STDERR "check-there: fd 9: $!\n"; exit 2 };
    my $until = time + ($ARGV[0] eq "-w" ? $ARGV[1] : 0);
    until (flock($f, LOCK_EX | LOCK_NB)) {
      $! == EWOULDBLOCK or do { print STDERR "check-there: flock: $!\n"; exit 2 };
      exit 1 if time >= $until;
      sleep 1;
    }
  ' -- "$@"
}
# Wait for the lock only while another check holds it, saying whose turn
# it is, and at most `turn_wait_s`: a check that hung would otherwise keep
# every later one waiting with no word. A wait that runs out exits 75, so
# it reads apart from a failed check. A lock that can't be tried fails
# the check, which would otherwise share the worktree.
take_turn() {
  local tried=0 held wait_s="${turn_wait_s:-5400}"
  lock -n || tried=$?
  if [ "$tried" -eq 1 ]; then
    held=$(cat "$turn.holder" 2>/dev/null || echo "unsaid")
    echo "check-there: another check runs on $(hostname) ($held); waiting its turn" >&2
    # A second's try at a time, so a stop meanwhile, held until the
    # command it lands in ends, lands within one.
    local tries=0
    while [ "$tried" -eq 1 ] && [ "$tries" -lt "$wait_s" ]; do
      tried=0
      lock -w 1 || tried=$?
      tries=$(( tries + 1 ))
    done
    if [ "$tried" -eq 1 ]; then
      held=$(cat "$turn.holder" 2>/dev/null || echo "unsaid")
      echo "check-there: gave up after ${wait_s} s waiting for $(hostname)'s check lock, held by ($held)" >&2
      return 75
    fi
  fi
  if [ "$tried" -ne 0 ]; then
    echo "check-there: can't take $(hostname)'s check lock" >&2
    return "$tried"
  fi
  holder="$turn.holder"
  printf '%s, pid %s, from %s\n' "${branch:-a branch}" "$$" "$(date '+%a %H:%M')" > "$holder" || true
}
turn=~/.cache/harness-check.lock
exec 9> "$turn"
take_turn
# Everything the check starts runs alone.
run_check() {
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
}
alone run_check
THERE

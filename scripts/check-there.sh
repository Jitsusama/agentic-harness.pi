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
# one waits CHECK_THERE_WAIT_S seconds (5400 by default), never fewer and
# a second or two more, for the check before it to end, and a Mac doesn't
# idle to sleep while a check there runs. Its holder's line names the pid that stops
# the whole of a check with a TERM, its turn passing once its work has
# stopped. A check whose caller goes away stops the same way, since
# without a pty sshd signals nothing as it goes and the check asks after
# it each second instead: within a second or so of its ssh being killed,
# and of the host's sshd noticing a dropped connection, which by sshd's
# defaults waits on TCP and so may take hours. Each waiter's limit is
# its own, and waiters take the turn in no order, so a 75 says only that
# its turn didn't come in time, not that the check before it hung.
#
# Of its exit codes a caller can act on two alone: 75 when its turn
# never came, and 3 when the host's lock can't be taken at all. The
# check's own 3 or 75 comes back as 1, said in a line of its own that
# doesn't open `check-there:`, since it is a failing check. Any other
# is the check's own, tests/package's after it, or what failed under
# it, such as ssh's 255 when the host can't be reached or its link is
# silent for five minutes, or git's own when a fetch fails. Whatever it refuses, a
# branch, host, wait or agent, a host with no node or no pnpm for the
# branch among them, it says in a `check-there:` line on stderr, which
# is what tells a refusal from a failing check. A TERM, INT or HUP sent
# to the holder's pid on the host ends it with 143, 130 or 129; a stop
# at the caller's own terminal ends its ssh, so it comes back as ssh's
# code. On a 255 the host's check may hold its turn until the host's
# sshd notices the link went, and the holder's line names its pid.
#
# Its checks run one after another in a tree each branch's code ran in,
# whose untracked files and node_modules outlast it, so a check trusts
# the branches checked before it there as much as its own.
#
# A check an agent runs goes to penelope alone, the host agreed for
# agents' checks (ISXEG8, 22 November): another, as the Mac does, would
# run a pushed branch's install scripts and tests as an account holding
# Joel's credentials, outside any agent fence, on an agent's say alone.
# Nothing here shows penelope's account is any less Joel's: the
# agreement is the reason, not a fence this script knows of. That lifts
# once a host runs it inside its agent fence or under an account of its
# own. Another host is refused by default: it takes a check only typed
# at a terminal, stdin one, with no pi, pi-spawner, mycelium or
# pi-host-runtime among the processes it runs under, and never with
# PI_SESSION_ID set. Trusting PI_SESSION_ID alone let a systemd unit an
# agent started, which carries none, send two checks to the Mac on 24
# November (ISXEG8's incident). This guards against such a slip, not
# against an agent set on reaching the Mac, which can ssh there by hand:
# only a fence holds that. Joel typing it in his own terminal may send
# it anywhere, and runs the branch's code as himself there, whoever
# wrote it, so the refusal points an agent at penelope and nowhere else.
set -euo pipefail

# Whether a process this runs under is pi's: pi itself, its spawner, a
# host's runtime or a mycelium node, read from each forebear's command
# up to the first process. A forebear that can't be read counts as
# pi's, so a check never goes further than it can tell it may.
under_pi() {
  local pid=$PPID ppid args program hops=0
  while [ "$pid" -gt 1 ]; do
    # A chain past 256 processes is no shell's: refused, not walked on.
    [ "$hops" -lt 256 ] || return 0
    args=$(ps -o args= -p "$pid" 2> /dev/null) || return 0
    program=${args%% *}
    case "${program##*/}" in
      pi | pi-spawner | mycelium) return 0 ;;
    esac
    case "$program" in
      *pi-host-runtime*) return 0 ;;
    esac
    ppid=$(ps -o ppid= -p "$pid" 2> /dev/null) || return 0
    pid=${ppid//[!0-9]/}
    [ -n "$pid" ] || return 0
    hops=$((hops + 1))
  done
  return 1
}

branch="${1:-$(git rev-parse --abbrev-ref HEAD)}"
host="${2:-penelope}"
wait_s="${CHECK_THERE_WAIT_S:-5400}"
# A wait is at most seven digits, over a hundred days, so no slip of the
# keys asks for one that never ends, and opens with no zero, which the
# host's arithmetic would read as octal.
case "$wait_s" in
  *[!0-9]* | ????????* | 0?*)
    echo "check-there: CHECK_THERE_WAIT_S is '$wait_s', not a number of seconds under ten million, with no leading zero" >&2
    exit 2
    ;;
esac
# ssh joins its words into one line the host's login shell, bash or zsh,
# reads again, and git lets a branch's name hold `;` and `$(`, so a check
# takes only a branch named in plain characters. ssh would read a host
# that opens with a dash, or a name after its user that does, as one of
# its options, and an older ssh puts the name as it stands into a
# ProxyCommand's shell line. Past 160 characters the holder's line it
# writes would read to every waiter as not in its shape.
case "$branch" in
  '' | -* | *[!A-Za-z0-9._/@+-]*)
    echo "check-there: '$branch' names no branch a check can take" >&2
    exit 2
    ;;
esac
if [ "${#branch}" -gt 160 ]; then
  echo "check-there: '$branch' is past 160 characters, longer than a check's holder's line names" >&2
  exit 2
fi
case "$host" in
  -* | *@-* | *[!A-Za-z0-9._@-]*)
    echo "check-there: '$host' names no host" >&2
    exit 2
    ;;
esac
if [ "$host" != penelope ]; then
  if [ -n "${PI_SESSION_ID:-}" ]; then
    echo "check-there: a check run under pi (PI_SESSION_ID is set) goes only to the host named penelope, the one agreed for agents' checks; run pnpm check:there $branch penelope" >&2
    exit 2
  fi
  if ! [ -t 0 ]; then
    echo "check-there: a check with no terminal, as a unit or a pipe runs it, goes only to the host named penelope, the one agreed for agents' checks; run pnpm check:there $branch penelope" >&2
    exit 2
  fi
  if under_pi; then
    echo "check-there: a check run under pi, its spawner, a host or a mycelium node (or under a process it can't read) goes only to the host named penelope, the one agreed for agents' checks; run pnpm check:there $branch penelope" >&2
    exit 2
  fi
fi

if [ "$#" -lt 1 ]; then
  git fetch -q origin "$branch"
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$branch")" ]; then
    echo "check-there: $branch differs from origin/$branch; push it first" >&2
    exit 2
  fi
fi

# The branch goes quoted all the same, should its characters ever widen.
# The check has a connection of its own, never a shared master's, so the
# sshd that starts its shell goes when its ssh does. A host asleep, or a
# link silent mid-check, ends it with ssh's 255 after five minutes, not
# when TCP gives up hours on: long enough that a busy host or a wifi
# blip doesn't end an hour's check, short enough that a caller hears of
# a lost host. The host's check may then hold its turn until its sshd
# notices; the holder's line names the pid to stop it by.
exec ssh -o BatchMode=yes -o ControlMaster=no -o ControlPath=none \
  -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=20 "$host" "bash -s -- $(printf '%q' "$branch") $wait_s" <<'THERE'
set -euo pipefail
# Each job this shell starts leads a process group of its own, so a stop
# reaches a check's work, and waits for all of it, without signalling
# this shell or the one ssh started it from.
set -m
# What the stop acts on starts empty, whatever the host's shell exports.
holder= node_link= ending= deadline= killed= stop_wait_s=
# What started this shell: the sshd that goes once the caller's ssh does,
# since bash and zsh, the hosts' login shells, run a lone command they
# are given in place of themselves.
caller=$PPID
# A login shell whose startup set a trap runs the command under itself,
# and stays when its caller goes, so the check says so where ps can tell.
note_caller() {
  local named
  named="$(ps -o comm= -p "$caller" 2>/dev/null || true)"
  case "$named" in
    "" | *sshd*) ;;
    *) echo "check-there: started under $named, not sshd, so it won't see its caller go" >&2 ;;
  esac
}
note_caller
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
# Whether the groups named have all ended before the clock reaches
# `deadline`, asked every tenth of a second, since nothing says when a
# group's last member goes. The clock is bash's SECONDS, whole seconds
# even in bash 3.2, so a busy machine stretches only the asking.
gone_within() {
  local group
  for group in "$@"; do
    while kill -0 -- "-$group" 2>/dev/null; do
      [ "$SECONDS" -lt "$deadline" ] || return 1
      sleep 0.1
    done
  done
}
# Ends the groups named: a TERM, `stop_wait_s` seconds for them to go,
# never fewer and at most one more, then a KILL to what is left, said so,
# and five seconds or so for that. A stop landing while alone ends what
# its work left goes on to alone's deadline, and once alone has killed
# goes on with its KILL, rather than starting either again. Its caller
# may be gone, so a write that fails passes over. Its return says 0
# outright: in a trap, a bare one says what the command the trap landed
# in ended with.
end_groups() {
  local group
  # None named, as a stop while waiting its turn has it: an empty "$@"
  # under `set -u` is an error to some older bash.
  [ "$#" -gt 0 ] || return 0
  if [ -z "${killed:-}" ]; then
    for group in "$@"; do kill -TERM -- "-$group" 2>/dev/null || true; done
    [ -n "${deadline:-}" ] || deadline=$(( SECONDS + ${stop_wait_s:-10} + 1 ))
    if gone_within "$@"; then
      deadline=
      return 0
    fi
    echo "check-there: what it ran outlived ${stop_wait_s:-10} s, so it was killed" >&2 || true
    # One command, so a stop landing between them never finds the KILL
    # under way with the TERM's spent deadline.
    deadline=$(( SECONDS + 6 )) killed=1
  fi
  for group in "$@"; do kill -KILL -- "-$group" 2>/dev/null || true; done
  gone_within "$@" || true
  deadline= killed=
}
# Stops the check as the signal its code `$1` names, or as `$2` says when
# no signal stopped it, said so its caller can tell a stop from a failed
# check, and a turn given up from one never taken. Its caller may be
# gone, so a write that fails passes over, rather than ending this shell
# before its work.
stop_all() {
  trap '' TERM INT HUP PIPE
  local groups why="${2:-$(kill -l $(( $1 - 128 )))}"
  if [ -n "${holder:-}" ]; then
    echo "check-there: stopped by $why; ending what it runs, then passing its turn" >&2 || true
  else
    echo "check-there: stopped by $why before it took its turn; ending what it runs" >&2 || true
  fi
  # alone's job may be gone from the table while its group isn't.
  groups="$(jobs -p) ${ending:-}"
  # shellcheck disable=SC2086 # one word a group
  end_groups $groups
  exit "$1"
}
trap 'stop_all 143' TERM
trap 'stop_all 130' INT
trap 'stop_all 129' HUP
# Whether the sshd this shell runs under is still there. It goes when
# the caller's ssh does, killed or cut off, but sends nothing as it
# goes, so the check's waits ask after it each second.
caller_here() {
  kill -0 "$caller" 2>/dev/null
}
# Stops the check as a hang-up would, once nobody reads what it says: its
# sshd gone, or a write of its own finding its reader gone, which would
# otherwise end this shell with its work still running. A trap that runs
# a command, not one that ignores the signal, so its jobs start as ever.
caller_gone() {
  stop_all 129 "its caller going"
}
trap caller_gone PIPE
# Runs a command as a job in a group of its own and without fd 9, and
# ends what it left in its group as it ends, so the turn passes with
# none of it running; what leaves the group, as git's fsmonitor daemon
# may, holds no lock as it runs on. A job under `set -m` keeps this
# shell's stdin, the script `bash -s` reads, so it gets none, and
# nothing in it can swallow the script. It is asked after every second
# rather than waited on, since a signal landing just as `wait` begins
# waits for the job's end; a trap runs as soon as the second's sleep
# ends. Work that would have no group of its own is refused before it
# runs, since no stop could reach it: with job control off, or in a
# subshell, which bash runs with it off whatever its `$-` says. Its
# group is named for a stop as it starts, so a stop landing at any point
# after reaches it, whatever bash's job table still holds.
alone() {
  case "$-:$BASH_SUBSHELL" in
    *m*:0) ;;
    *)
      echo "check-there: $1 got no process group of its own, so no stop could reach it" >&2
      return 1
      ;;
  esac
  # The job turns errexit on again, since its code is read with it off,
  # and else the work would run on past a failed step.
  { set -e; "$@"; } 9>&- </dev/null &
  local job=$! status=0
  ending=$job
  while kill -0 "$job" 2>/dev/null; do
    caller_here || caller_gone
    sleep 1
  done
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
# A Mac sleeps once nobody has touched it a while, however hard it
# works, which would freeze a check there mid-build or with its turn
# held; so a check holds it awake for as long as this shell lives,
# building node, waiting or running.
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -i -w "$$" </dev/null >/dev/null 2>&1 &
fi
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
  echo "check-there: no node on $(hostname), so it builds node 24 from nixpkgs" >&2
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
# when it couldn't try it, as flock(1) does, saying why.
lock() {
  if command -v flock >/dev/null 2>&1; then
    flock "$@" 9
    return
  fi
  if ! command -v perl >/dev/null 2>&1; then
    echo "check-there: $(hostname) has neither flock nor perl to lock with" >&2
    return 127
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
# The holder's line as its holder wrote it, which that check's own code
# can rewrite, so it is said only when it reads as take_turn writes it,
# in plain characters: no escapes or reordering marks reach a terminal,
# nor words another session would read as this script's. It is read
# only from a plain file, at most 200 bytes of it for at most a second,
# opened for writing too, which never waits on a FIFO, so neither a FIFO
# nor a link to an endless device can hold the waiter, even one swapped
# in after the look; and only with bash's own read, which every host has.
# Its time is in digits, so a host's locale can't make it another shape.
held_by() {
  local LC_ALL=C said=
  local shape='^([A-Za-z0-9._/@+-]{1,160}|a branch), pid [0-9]+, from [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$'
  if [ -f "$turn.holder" ] && [ ! -L "$turn.holder" ]; then
    IFS= read -r -t 1 -n 200 said 2>/dev/null <> "$turn.holder" || true
  fi
  if [ -z "$said" ]; then
    echo unsaid
  elif [[ $said =~ $shape ]]; then
    echo "$said"
  else
    echo "a line not in its shape"
  fi
}
take_turn() {
  local tried=0 held wait_s=$(( 10#${turn_wait_s:-5400} ))
  lock -n || tried=$?
  if [ "$tried" -eq 1 ]; then
    held=$(held_by)
    echo "check-there: another check runs on $(hostname) ($held); waiting its turn" >&2
    # A second's try at a time, so a stop meanwhile, held until the
    # command it lands in ends, lands within one; the wait is timed by
    # the clock, so slow tries on a busy host don't stretch it. The clock
    # is whole seconds, so it waits one more, never fewer than it says.
    local ends_at=$(( SECONDS + wait_s + 1 ))
    while [ "$tried" -eq 1 ] && [ "$SECONDS" -lt "$ends_at" ]; do
      caller_here || caller_gone
      tried=0
      lock -w 1 || tried=$?
    done
    if [ "$tried" -eq 1 ]; then
      held=$(held_by)
      echo "check-there: gave up after ${wait_s} s waiting for $(hostname)'s check lock, held by ($held)" >&2
      return 75
    fi
  fi
  if [ "$tried" -ne 0 ]; then
    # Its own code, since the lock tool's own, a 2 among them, would read
    # as one of the script's.
    echo "check-there: can't take $(hostname)'s check lock (its lock exited $tried)" >&2
    return 3
  fi
  holder="$turn.holder"
  # A fresh file, so a link or a FIFO left in its place takes no line.
  rm -f "$holder"
  printf '%s, pid %s, from %s\n' "${branch:-a branch}" "$$" "$(date '+%Y-%m-%d %H:%M')" > "$holder" || true
}
# What the check finds on its host, each said on stdout, or nothing when
# it isn't there: globs, not ls in a pipe, since under errexit and
# pipefail a match of none would end the check before it said why.
# The pnpm store `$1` holds for the version `$2`.
pnpm_in() {
  local found
  for found in "$1"/*-pnpm-"$2"/bin; do
    if [ -d "$found" ]; then
      echo "$found"
      return
    fi
  done
}
# glibc's own loader in store `$1`, never its -bin output's stub.
loader_in() {
  local found ld=
  for found in "$1"/*-glibc-2.*/lib/ld-linux-x86-64.so.2; do
    case "$found" in
      "$1"/*-bin/*) ;;
      *) if [ -e "$found" ]; then ld=$found; fi ;;
    esac
  done
  if [ -n "$ld" ]; then echo "$ld"; fi
}
# npm's prebuilt biome in tree `$1`'s install.
biome_in() {
  local found
  for found in "$1"/node_modules/.pnpm/@biomejs+cli-linux-x64@*/node_modules/@biomejs/cli-linux-x64/biome; do
    if [ -e "$found" ]; then
      echo "$found"
      return
    fi
  done
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
bin=$(pnpm_in /nix/store "$want")
if [ -z "$bin" ]; then
  echo "check-there: no pnpm $want in $(hostname)'s store" >&2
  exit 1
fi
export PATH="$bin:$PATH"
pnpm install --frozen-lockfile --silent
# On NixOS a prebuilt binary finds only nix-ld's stub loader, which runs
# nothing without nix-ld set up, so biome is run through glibc's by hand.
if [ -e /etc/NIXOS ]; then
  ld=$(loader_in /nix/store)
  real=$(biome_in "$PWD")
  if [ -z "$ld" ] || [ -z "$real" ]; then
    echo "check-there: no glibc loader or no biome on $(hostname) to run biome by" >&2
    exit 1
  fi
  mkdir -p ~/.cache/harness-check-bin
  printf '#!/bin/sh\nexec %q %q "$@"\n' "$ld" "$real" > ~/.cache/harness-check-bin/biome
  chmod +x ~/.cache/harness-check-bin/biome
  export BIOME_BINARY=~/.cache/harness-check-bin/biome
fi
pnpm check
pnpm exec vitest run tests/package --testTimeout=60000
}
# The branch's own code can exit 3 or 75, which a caller reads as this
# script's, so either comes back as 1, said; errexit is off only while
# the check is waited on, so its code reaches the line that reads it.
set +e
alone run_check
checked=$?
set -e
case "$checked" in
  3 | 75)
    echo "the check on $(hostname) exited $checked, a code check-there keeps for its own, so it ends 1" >&2
    exit 1
    ;;
esac
exit "$checked"
THERE

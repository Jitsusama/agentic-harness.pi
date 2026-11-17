#!/usr/bin/env bash
# Sends store paths, with whatever of their closure a lent builder lacks,
# to each lent builder that stands, ahead of `nix-offload there --copy`,
# so its own copy finds them there and sends nothing. nix-offload's copy
# is one stream of the whole uncompressed closure, all or nothing: on 16
# November the 441 MB pi-host runtime failed to reach a lender all
# evening over the home uplink, and every harness host test with it.
#
#   scripts/host-send-runtime.sh PATH...
#
# The lenders are the ones nix-offload names by store URI in the files
# NIX_OFFLOAD_STORES lists (colon-separated; /run/nix-offload/store and
# /run/nix-offload-more/store), with the key and host key each URI gives.
# The host key is written to a file of this script's own on every send,
# since nix-offload removes its known-hosts file when each run ends, and a
# URI without one is refused. Where no lender stands it does nothing, and
# nix-offload copies as before when it makes one. Each lender that stands
# is sent to, since either may take the run.
#
# For each lender it asks which paths of the closure its store lacks, and
# only those go, and only ones in the closure, whatever the lender says:
# as an xz file cache (the runtime's 221 MB NAR is 32 MB), tarred and cut
# into 1 MB pieces (HOST_SEND_PIECE_BYTES). A piece is sent again until
# its size there matches, and the whole is checked by its sha256. The
# lender's own nix then takes the cache in with the signatures checked:
# its nix-offload account is untrusted and its store requires signatures,
# so only what a key it trusts signed goes in, as optimus-1 signs what it
# builds. A lender that refuses a cache's signatures isn't sent that cache
# again for a week.
#
# The pieces are kept here in XDG_CACHE_HOME, and on the lender in a
# folder named for this machine (HOST_SEND_FROM, its short host name) and
# the pieces' sha256, so a send cut off is taken up again where it
# stopped, a piece made by another cache never passes for one of this
# one's, and two machines sending to one lender keep apart. Only a lost
# ssh connection is tried again (HOST_SEND_TRIES times, HOST_SEND_PAUSE
# seconds apart); a lender refusing gives that lender up at once.
#
# The whole send, the wait for another send's lock included, gives up
# after HOST_SEND_SECONDS (an ssh call running then is cut off where
# `timeout` is found), and exits 1 when a lender couldn't be sent to,
# which host-test-there.sh notes and goes on from, its copy left to
# nix-offload. HOST_SEND_SECONDS=0 skips the send.
#
# It can't run inside pi's agent fence, which hides the builders' key, so
# host-test-there.sh calls it only outside, and the lone nix-offload call
# it prints inside the fence copies as before.
set -euo pipefail

PIECE=${HOST_SEND_PIECE_BYTES:-1048576}
TRIES=${HOST_SEND_TRIES:-40}
PAUSE=${HOST_SEND_PAUSE:-5}
# An hour, after which nix-offload is left to copy what's left, and the
# next run takes the send up where this one stopped.
DEADLINE=${HOST_SEND_SECONDS:-3600}
STORES=${NIX_OFFLOAD_STORES:-/run/nix-offload/store:/run/nix-offload-more/store}
STORE_DIR=${NIX_STORE_DIR:-/nix/store}
ME=${HOST_SEND_FROM:-$(hostname -s)}
ME=${ME//[^A-Za-z0-9-]/_}

say() { echo "host-send-runtime: $*" >&2; }
# Whether `$1` is a store path, which is safe in a remote shell's words,
# as nix names them.
stored() {
  [[ $1 == "$STORE_DIR"/* && ${1#"$STORE_DIR"/} =~ ^[A-Za-z0-9+_=-][A-Za-z0-9+._=-]*$ ]]
}

if [[ $# -eq 0 ]]; then
  echo "usage: scripts/host-send-runtime.sh PATH..." >&2
  exit 64
fi
# The store's own folder reaches the lender's shell too.
if [[ ! $STORE_DIR =~ ^/[A-Za-z0-9+._/-]+$ ]]; then
  say "the store folder $STORE_DIR isn't one to name in a lender's shell"
  exit 64
fi
for path; do
  stored "$path" || {
    say "$path isn't a store path"
    exit 64
  }
done
if [[ $DEADLINE == 0 ]]; then
  say "HOST_SEND_SECONDS is 0, so nix-offload copies $* itself"
  exit 0
fi

sha() { if command -v sha256sum > /dev/null; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1; }
# A setting of a store URI's, from its `name=value&...`, its %-escapes
# undone as nix undoes them.
setting() {
  local value
  value=$(tr '&' '\n' <<< "$2" | sed -n "s/^$1=//p" | sed -n 1p)
  printf '%b' "${value//%/\\x}"
}
late() { [[ $SECONDS -ge $DEADLINE ]]; }

scratch=$(mktemp -d "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/hsr.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
sends=${XDG_CACHE_HOME:-$HOME/.cache}/pi-host/send
mkdir -p "$sends"
# One send at a time from this account, since two would share the caches
# here and there. The wait counts against the deadline.
if command -v flock > /dev/null; then
  exec {lock}> "$sends/.lock"
  if ! flock -n "$lock"; then
    say "waiting for another send to end"
    flock -w "$DEADLINE" "$lock" || {
      say "another send held the lock for the whole deadline"
      exit 1
    }
  fi
else
  say "no flock here, so a second send from this account at once would share its caches"
fi
# Sends and refusals kept more than a week are spent.
find "$sends" -mindepth 1 -maxdepth 1 ! -name .lock -mtime +7 -exec rm -rf {} +

# ssh to the lender with `ssh_words`, its options and then its host, as
# nix-offload reaches it, with no shared connection, which would outlive
# this script holding its lock and its caller's output. A connection lost
# for a minute is given up on, so a stalled uplink is tried again on a
# fresh one, and one still running at the deadline is cut off, read as a
# lost connection the next run takes up. The cut-off keeps ssh in this
# script's process group, so an interrupt or a kill of the group stops it
# rather than leaving it holding the lock.
# shellcheck disable=SC2029 # the command is built here to run there
on() {
  local code=0
  if command -v timeout > /dev/null; then
    timeout --foreground "$((DEADLINE > SECONDS ? DEADLINE - SECONDS : 1))" ssh "${ssh_words[@]}" "$@" || code=$?
  else
    ssh "${ssh_words[@]}" "$@" || code=$?
  fi
  [[ $code != 124 ]] || code=255
  return "$code"
}

# What the lender prints for `$1`, run there with stdin from `$2`, tried
# again only while ssh itself fails (255), `$3` times at most.
remote() {
  local tries=0 out code
  while :; do
    code=0
    out=$(on "$1" < "${2:-/dev/null}") || code=$?
    [[ $code == 255 ]] || break
    tries=$((tries + 1))
    if [[ $tries -ge ${3:-$TRIES} ]] || late; then break; fi
    sleep "$PAUSE"
  done
  [[ $code == 0 ]] || return "$code"
  printf '%s\n' "$out"
}

# The size of the piece named `$1` there, from a listing of `name size`.
size_there() { awk -v n="$1" '$1 == n { print $2 }' <<< "$2"; }

# Builds the cache of the paths in `missing` in `work`, its pieces and,
# last, its sha256, so pieces half made are made again.
pack() {
  rm -rf "$work" &&
    mkdir -p "$work/cache" "$work/pieces" &&
    nix copy --to "file://$work/cache?compression=xz&parallel-compression=true" --no-recursive -- "${paths[@]}" &&
    tar cf "$work/send.tar" -C "$work/cache" . &&
    (cd "$work/pieces" && split -b "$PIECE" -a 4 ../send.tar p.) &&
    sha < "$work/send.tar" > "$work/sha256.part" &&
    [[ -s $work/sha256.part ]] &&
    rm "$work/send.tar" &&
    mv "$work/sha256.part" "$work/sha256"
}

# This machine's folder on the lender, removed, and the shared one when
# nothing else is in it.
CLEAR="rm -rf pi-host-send/$ME; rmdir pi-host-send 2> /dev/null; true"
# The kept sends this run used, removed once every lender holds them.
used=()

send_to() {
  local uri=$1 rest host settings key host_key known alias
  shift
  rest=${uri#ssh-ng://}
  rest=${rest#ssh://}
  host=${rest%%\?*}
  if [[ ! $host =~ ^([A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    say "the store URI's host $host isn't one ssh should be given"
    return 1
  fi
  settings=${rest#"$host"}
  settings=${settings#\?}
  key=$(setting ssh-key "$settings")
  host_key=$(setting base64-ssh-public-host-key "$settings")
  alias=${host##*@}
  # Nothing of this account's goes along: no agent, display or forwarding,
  # and no command run here, whatever its ssh config says.
  ssh_words=(-a -x -o BatchMode=yes -o ConnectTimeout=30
    -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o Compression=no
    -o ControlMaster=no -o ControlPath=none -o ClearAllForwardings=yes
    -o PermitLocalCommand=no -o IdentitiesOnly=yes -o IdentityAgent=none)
  if [[ -z $key ]]; then
    say "the store URI for $alias gives no key to sign in with"
    return 1
  fi
  ssh_words+=(-i "$key")
  if [[ -z $host_key ]]; then
    say "the store URI for $alias gives no host key to check it by"
    return 1
  fi
  if ! known=$(base64 -d <<< "$host_key" 2> /dev/null) || [[ -z $known || $known == *$'\n'* ]]; then
    say "the store URI for $alias gives a host key that isn't one"
    return 1
  fi
  printf '%s %s\n' "$alias" "$known" > "$scratch/$alias.known"
  ssh_words+=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$scratch/$alias.known"
    -o "HostKeyAlias=$alias")
  ssh_words+=(-- "$host")

  local answer missing
  answer=$(remote "xargs nix-store --check-validity --print-invalid" "$scratch/closure" 3) || {
    say "couldn't ask $alias what it lacks"
    return 1
  }
  # Only paths of the closure go, whatever the lender answered.
  missing=$(grep -Fx -f "$scratch/closure" <<< "$answer" || true)
  while read -r path; do
    [[ -z $path ]] || stored "$path" || {
      say "$alias named $path, which isn't a store path"
      return 1
    }
  done <<< "$missing"
  if [[ -z $missing ]]; then
    say "$alias already holds $*"
    remote "$CLEAR" > /dev/null || true
    return 0
  fi
  local -a paths
  mapfile -t paths <<< "$missing"
  local id work sum there refused
  id=$(sha <<< "$missing" | cut -c1-16)
  work=$sends/$id
  refused=$sends/$id.refused-by-$alias
  if [[ -e $refused ]]; then
    say "$alias refused this cache's signatures this week, so nix-offload copies $* itself"
    return 1
  fi
  say "$alias lacks ${#paths[@]} of the closure's paths; sending them in pieces"
  if [[ ! -s $work/sha256 ]]; then
    pack || {
      say "couldn't make the cache to send"
      rm -rf "$work"
      return 1
    }
  fi
  touch "$work"
  used+=("$work")
  # What goes into the lender's shell from here is checked first, since the
  # cache is only as safe as this account's files.
  sum=$(cut -c1-16 "$work/sha256")
  if [[ ! $sum =~ ^[0-9a-f]{16}$ ]]; then
    say "the kept send $work is damaged; it's removed, to be made again"
    rm -rf "$work"
    return 1
  fi
  there=pi-host-send/$ME/$sum
  local -a pieces=("$work"/pieces/p.????)
  for piece in "${pieces[@]}"; do
    if [[ ! -s $piece || ! ${piece##*/} =~ ^p\.[a-z]{4}$ ]]; then
      say "the kept send $work is damaged; it's removed, to be made again"
      rm -rf "$work"
      return 1
    fi
  done

  local listing piece name want got tries code sent=0
  listing=$(remote "mkdir -p $there/pieces && find pi-host-send/$ME -mindepth 1 -maxdepth 1 ! -name $sum -exec rm -rf {} + && cd $there/pieces && for f in p.????; do [ -e \"\$f\" ] && echo \"\$f \$(wc -c < \"\$f\")\"; done; true") || {
    say "couldn't reach $alias"
    return 1
  }
  for piece in "${pieces[@]}"; do
    name=${piece##*/}
    if [[ ! -s $piece ]]; then
      say "$name went from here mid-send; the next run makes it again"
      return 1
    fi
    want=$(wc -c < "$piece" | tr -d ' ')
    got=$(size_there "$name" "$listing")
    tries=0
    while [[ $got != "$want" ]]; do
      tries=$((tries + 1))
      if [[ $tries -gt $TRIES ]] || late; then
        say "$name wouldn't go to $alias; the next run takes it up from there"
        return 1
      fi
      # The lender answers the size it got, so a piece costs one call.
      code=0
      got=$(on "cat > $there/pieces/$name.part && mv $there/pieces/$name.part $there/pieces/$name && wc -c < $there/pieces/$name" < "$piece" | tr -d ' ') || code=$?
      if [[ $code == 255 ]]; then
        sleep "$PAUSE"
        # One try: a lost connection here is the next upload's to retry.
        got=$(remote "wc -c < $there/pieces/$name 2> /dev/null || echo 0" "" 1 | tr -d ' ') || got=
      elif [[ $code != 0 ]]; then
        say "$alias refused $name (exit $code); its folder is removed"
        remote "$CLEAR" > /dev/null || true
        return 1
      fi
    done
    sent=$((sent + 1))
    if ((sent % 10 == 0)); then say "$alias has $sent of ${#pieces[@]} pieces"; fi
  done

  want=$(cat "$work/sha256")
  got=$(remote "cd $there && cat pieces/p.???? > send.tar && { sha256sum send.tar 2> /dev/null || shasum -a 256 send.tar; } | cut -d' ' -f1") || {
    say "couldn't put the pieces together on $alias"
    return 1
  }
  if [[ $got != "$want" ]]; then
    say "the pieces on $alias make $got, not $want; they're removed here and there, to be made and sent again"
    remote "rm -rf $there" > /dev/null || true
    rm -rf "$work"
    return 1
  fi
  # Taken in already counts, since a connection lost after the import
  # would otherwise try it again from a folder it removed. A refusal of the
  # signatures exits 3, told apart from a failure the next run may not
  # meet, such as a full disk.
  code=0
  remote "nix path-info ${paths[*]} > /dev/null 2>&1 || { cd $there && rm -rf cache && mkdir cache && tar xf send.tar -C cache && { nix copy --from file://\$HOME/$there/cache --no-recursive ${paths[*]} 2> import.err || { cat import.err >&2; if grep -q 'lacks a signature' import.err; then exit 3; fi; exit 1; }; }; } && nix path-info $* > /dev/null && cd && { $CLEAR; }" > /dev/null || code=$?
  if [[ $code == 255 ]]; then
    say "lost $alias while its nix took the cache in; the next run takes it up"
    return 1
  elif [[ $code == 3 ]]; then
    # Sent again it would be refused again, so nothing of it is kept, and
    # it isn't sent this lender again for a week.
    say "$alias's nix wouldn't take the cache in, refusing its signatures; it's removed there and here"
    remote "$CLEAR" > /dev/null || true
    rm -rf "$work"
    touch "$refused"
    return 1
  elif [[ $code != 0 ]]; then
    # Only the pieces stay, which is all the next run needs, so the
    # lender's disk has room for nix-offload's own copy.
    say "$alias's nix couldn't take the cache in (exit $code); the pieces are kept for the next run"
    remote "rm -rf $there/send.tar $there/cache $there/import.err" > /dev/null || true
    return 1
  fi
  say "$alias holds $*"
}

IFS=: read -ra files <<< "$STORES"
stood=0
failed=0
for file in "${files[@]}"; do
  [[ -s $file ]] || continue
  if [[ $stood == 0 ]]; then
    nix path-info --recursive -- "$@" > "$scratch/closure"
    stood=1
  fi
  send_to "$(sed -n 1p "$file")" "$@" || failed=1
done
if [[ $stood == 0 ]]; then
  say "no lender stands, so nix-offload copies $* itself when it makes one"
elif [[ $failed == 0 && ${#used[@]} -gt 0 ]]; then
  rm -rf "${used[@]}"
fi
exit "$failed"

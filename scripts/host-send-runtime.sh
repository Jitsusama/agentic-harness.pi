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
# since nix-offload removes its known-hosts file when each run ends. Where
# no lender stands it does nothing, and nix-offload copies as before when
# it makes one. Each lender that stands is sent to, since either may take
# the run.
#
# For each lender it asks which paths of the closure its store lacks, and
# only those go, and only ones in the closure, whatever the lender says:
# as an xz file cache (the runtime's 221 MB NAR is 32 MB), tarred and cut
# into 1 MB pieces (HOST_SEND_PIECE_BYTES). A piece is sent again until
# its size there matches, and the whole is checked by its sha256. The
# lender's own nix then takes the cache in with the signatures checked:
# its nix-offload account is untrusted and its store requires signatures,
# so only what a key it trusts signed goes in, as optimus-1 signs what it
# builds.
#
# The pieces are kept here in XDG_CACHE_HOME, and on the lender in a
# folder named by their sha256, so a send cut off is taken up again where
# it stopped, and a piece made by another cache never passes for one of
# this one's. Only a lost ssh connection is tried again (HOST_SEND_TRIES
# times, HOST_SEND_PAUSE seconds apart); a lender refusing gives that
# lender up at once. The whole send gives up after HOST_SEND_SECONDS, and
# exits 1 when a lender couldn't be sent to, which host-test-there.sh
# notes and goes on from, its copy left to nix-offload.
set -euo pipefail
set -f

PIECE=${HOST_SEND_PIECE_BYTES:-1048576}
TRIES=${HOST_SEND_TRIES:-40}
PAUSE=${HOST_SEND_PAUSE:-5}
# An hour, after which nix-offload is left to copy what's left, and the
# next run takes the send up where this one stopped.
DEADLINE=${HOST_SEND_SECONDS:-3600}
STORES=${NIX_OFFLOAD_STORES:-/run/nix-offload/store:/run/nix-offload-more/store}
STORE_DIR=${NIX_STORE_DIR:-/nix/store}

say() { echo "host-send-runtime: $*" >&2; }
# Whether `$1` is a store path, which is safe in a remote shell's words,
# as nix names them.
stored() {
  [[ $1 == "$STORE_DIR"/* && ${1#"$STORE_DIR"/} =~ ^[A-Za-z0-9+._?=-]+$ ]]
}

if [[ $# -eq 0 ]]; then
  echo "usage: scripts/host-send-runtime.sh PATH..." >&2
  exit 64
fi
for path; do
  stored "$path" || { say "$path isn't a store path"; exit 64; }
done

sha() { if command -v sha256sum > /dev/null; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1; }
# A setting of a store URI's, from its `name=value&...`.
setting() { tr '&' '\n' <<< "$2" | sed -n "s/^$1=//p" | sed -n 1p; }
late() { [[ $SECONDS -ge $DEADLINE ]]; }

scratch=$(mktemp -d "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/hsr.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
sends=${XDG_CACHE_HOME:-$HOME/.cache}/pi-host/send
mkdir -p "$sends"
# One send at a time from this account, since two would share the caches
# here and there.
if command -v flock > /dev/null; then
  exec {lock}> "$sends/.lock"
  flock -w "$DEADLINE" "$lock" || { say "another send held the lock for the whole deadline"; exit 1; }
fi

# ssh to the lender with `ssh_words`, its options and then its host, as
# nix-offload reaches it. A connection lost for a minute is given up on,
# so a stalled uplink is tried again on a fresh one.
# shellcheck disable=SC2029 # the command is built here to run there
on() { ssh "${ssh_words[@]}" "$@"; }

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

send_to() {
  local uri=$1 rest host settings key host_key alias
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
  ssh_words=(-o BatchMode=yes -o ConnectTimeout=30
    -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o Compression=no)
  if [[ -n $key ]]; then
    ssh_words+=(-o IdentitiesOnly=yes -o IdentityAgent=none -i "$key")
  fi
  if [[ -n $host_key ]]; then
    printf '%s %s\n' "$alias" "$(base64 -d <<< "$host_key")" > "$scratch/$alias.known"
    ssh_words+=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$scratch/$alias.known"
      -o "HostKeyAlias=$alias")
  fi
  ssh_words+=(-- "$host")

  local answer missing
  answer=$(remote "xargs nix-store --check-validity --print-invalid" "$scratch/closure" 3) ||
    { say "couldn't ask $alias what it lacks"; return 1; }
  # Only paths of the closure go, whatever the lender answered.
  missing=$(grep -Fx -f "$scratch/closure" <<< "$answer" || true)
  while read -r path; do
    [[ -z $path ]] || stored "$path" || { say "$alias named $path, which isn't a store path"; return 1; }
  done <<< "$missing"
  if [[ -z $missing ]]; then
    say "$alias already holds $*"
    remote "rm -rf pi-host-send" > /dev/null || true
    return 0
  fi
  local -a paths
  mapfile -t paths <<< "$missing"
  local id work sum there
  id=$(sha <<< "$missing" | cut -c1-16)
  work=$sends/$id
  say "$alias lacks ${#paths[@]} of the closure's paths; sending them in pieces"
  # Sends of other closures are spent, here and there.
  find "$sends" -mindepth 1 -maxdepth 1 -type d ! -name "$id" -exec rm -rf {} +
  if [[ ! -s $work/sha256 ]]; then
    pack || { say "couldn't make the cache to send"; rm -rf "$work"; return 1; }
  fi
  sum=$(cut -c1-16 "$work/sha256")
  there=pi-host-send/$sum

  local listing piece name want got tries
  listing=$(remote "mkdir -p $there/pieces && find pi-host-send -mindepth 1 -maxdepth 1 ! -name $sum -exec rm -rf {} + && cd $there/pieces && for f in p.????; do [ -e \"\$f\" ] && echo \"\$f \$(wc -c < \"\$f\")\"; done; true") ||
    { say "couldn't reach $alias"; return 1; }
  for piece in "$work"/pieces/p.????; do
    name=${piece##*/}
    want=$(wc -c < "$piece" | tr -d ' ')
    got=$(size_there "$name" "$listing")
    tries=0
    while [[ $got != "$want" ]]; do
      tries=$((tries + 1))
      if [[ $tries -gt $TRIES ]] || late; then
        say "$name wouldn't go to $alias; the next run takes it up from there"
        return 1
      fi
      on "cat > $there/pieces/$name.part && mv $there/pieces/$name.part $there/pieces/$name" < "$piece" ||
        sleep "$PAUSE"
      got=$(remote "wc -c < $there/pieces/$name 2> /dev/null || echo 0" | tr -d ' ') || got=
    done
  done

  want=$(cat "$work/sha256")
  got=$(remote "cd $there && cat pieces/p.???? > send.tar && { sha256sum send.tar 2> /dev/null || shasum -a 256 send.tar; } | cut -d' ' -f1") ||
    { say "couldn't put the pieces together on $alias"; return 1; }
  if [[ $got != "$want" ]]; then
    say "the pieces on $alias make $got, not $want; they're removed here and there, to be made and sent again"
    remote "rm -rf $there" > /dev/null || true
    rm -rf "$work"
    return 1
  fi
  # Taken in already counts, since a connection lost after the import
  # would otherwise try it again from a folder it removed.
  remote "nix path-info ${paths[*]} > /dev/null 2>&1 || { cd $there && rm -rf cache && mkdir cache && tar xf send.tar -C cache && nix copy --from file://\$HOME/$there/cache --no-recursive ${paths[*]}; } && nix path-info $* > /dev/null && cd && rm -rf pi-host-send" > /dev/null ||
    { say "$alias's nix wouldn't take the cache in"; return 1; }
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
elif [[ $failed == 0 ]]; then
  find "$sends" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
fi
exit "$failed"

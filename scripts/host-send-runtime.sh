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
# Where none stands it does nothing, and nix-offload copies as before when
# it makes one.
#
# For each lender it asks which paths of the closure its store lacks, and
# only those go: as an xz file cache (the runtime's 221 MB NAR is 32 MB),
# tarred and cut into 1 MB pieces (HOST_SEND_PIECE_BYTES) over one ssh
# connection that rides out a stalled uplink. Each piece is checked by its
# size there and sent again until it matches, and the whole by its
# sha256. The lender's own nix then takes the cache in with the
# signatures checked: its nix-offload account is untrusted and its store
# requires signatures, so only what a key it trusts signed goes in, as
# optimus-1 signs what it builds. The pieces made here are kept in
# XDG_CACHE_HOME, and those already there are left, so a send cut off is
# taken up again where it stopped. It exits 1 when a lender couldn't be
# sent to, which host-test-there.sh notes and goes on from.
set -euo pipefail

PIECE=${HOST_SEND_PIECE_BYTES:-1048576}
# Tries at each step before the lender is given up on, and the seconds
# between them.
TRIES=${HOST_SEND_TRIES:-40}
PAUSE=${HOST_SEND_PAUSE:-5}
STORES=${NIX_OFFLOAD_STORES:-/run/nix-offload/store:/run/nix-offload-more/store}

if [[ $# -eq 0 ]]; then
  echo "usage: scripts/host-send-runtime.sh PATH..." >&2
  exit 64
fi

say() { echo "host-send-runtime: $*" >&2; }
sha() { if command -v sha256sum > /dev/null; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1; }
# A setting of a store URI's, from its `name=value&...`.
setting() { tr '&' '\n' <<< "$2" | sed -n "s/^$1=//p" | sed -n 1p; }

scratch=$(mktemp -d "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/hsr.XXXXXX")
trap 'rm -rf "$scratch"' EXIT

# ssh to the lender with `ssh_words`, its options and then its host, as
# nix-offload reaches it.
# shellcheck disable=SC2029 # the command is built here to run there
on() { ssh "${ssh_words[@]}" "$@"; }

# What the lender prints for `$1`, run there with stdin from `$2`, tried
# again while ssh fails.
remote() {
  local tries=0 out
  until out=$(on "$1" < "${2:-/dev/null}"); do
    tries=$((tries + 1))
    [[ $tries -lt $TRIES ]] || return 1
    sleep "$PAUSE"
  done
  printf '%s\n' "$out"
}

# The size of the piece named `$1` there, from a listing of `name size`.
size_there() { awk -v n="$1" '$1 == n { print $2 }' <<< "$2"; }

send_to() {
  local uri=$1 rest host settings key host_key alias
  shift
  rest=${uri#ssh-ng://}
  rest=${rest#ssh://}
  host=${rest%%\?*}
  settings=${rest#"$host"}
  settings=${settings#\?}
  key=$(setting ssh-key "$settings")
  host_key=$(setting base64-ssh-public-host-key "$settings")
  alias=${host##*@}
  ssh_words=(-o BatchMode=yes -o ConnectTimeout=30
    -o ServerAliveInterval=15 -o ServerAliveCountMax=40 -o Compression=no
    -o ControlMaster=auto -o "ControlPath=$scratch/$alias" -o ControlPersist=60)
  if [[ -n $key ]]; then
    ssh_words+=(-o IdentitiesOnly=yes -o IdentityAgent=none -i "$key")
  fi
  if [[ -n $host_key ]]; then
    printf '%s %s\n' "$alias" "$(base64 -d <<< "$host_key")" > "$scratch/$alias.known"
    ssh_words+=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$scratch/$alias.known"
      -o "HostKeyAlias=$alias")
  fi
  ssh_words+=("$host")

  local missing
  missing=$(remote "xargs nix-store --check-validity --print-invalid" "$scratch/closure") ||
    { say "couldn't ask $alias what it lacks"; return 1; }
  missing=$(grep . <<< "$missing" || true)
  if [[ -z $missing ]]; then
    say "$alias already holds $*"
    return 0
  fi
  local paths id work there
  paths=$(tr '\n' ' ' <<< "$missing")
  id=$(sha <<< "$missing" | cut -c1-16)
  work=${XDG_CACHE_HOME:-$HOME/.cache}/pi-host/send/$id
  there=pi-host-send/$id
  say "$alias lacks $(wc -l <<< "$missing" | tr -d ' ') paths; sending them in pieces"

  # The sha256 is written last, so pieces half made are made again.
  if [[ ! -s $work/sha256 ]]; then
    rm -rf "$work"
    mkdir -p "$work/cache" "$work/pieces"
    # shellcheck disable=SC2086 # store paths, split on purpose
    nix copy --to "file://$work/cache?compression=xz&parallel-compression=true" --no-recursive $paths ||
      { say "couldn't make the cache to send"; return 1; }
    tar cf "$work/send.tar" -C "$work/cache" .
    (cd "$work/pieces" && split -b "$PIECE" -a 4 ../send.tar p.)
    sha < "$work/send.tar" > "$work/sha256.part"
    rm "$work/send.tar"
    mv "$work/sha256.part" "$work/sha256"
  fi

  local listing piece name want got tries
  listing=$(remote "mkdir -p $there/pieces && cd $there/pieces && for f in p.*; do [ -e \"\$f\" ] && echo \"\$f \$(wc -c < \"\$f\")\"; done; true") ||
    { say "couldn't reach $alias"; return 1; }
  for piece in "$work"/pieces/p.*; do
    name=${piece##*/}
    want=$(wc -c < "$piece" | tr -d ' ')
    got=$(size_there "$name" "$listing")
    tries=0
    while [[ $got != "$want" ]]; do
      tries=$((tries + 1))
      [[ $tries -le $TRIES ]] || { say "$name wouldn't go to $alias"; return 1; }
      on "cat > $there/pieces/$name.part && mv $there/pieces/$name.part $there/pieces/$name" < "$piece" ||
        sleep "$PAUSE"
      got=$(remote "wc -c < $there/pieces/$name 2> /dev/null || echo 0" | tr -d ' ') || got=
    done
  done

  want=$(cat "$work/sha256")
  got=$(remote "cd $there && cat pieces/p.* > send.tar && { sha256sum send.tar 2> /dev/null || shasum -a 256 send.tar; } | cut -d' ' -f1") ||
    { say "couldn't put the pieces together on $alias"; return 1; }
  if [[ $got != "$want" ]]; then
    say "the pieces on $alias make $got, not $want; they're removed, to be sent again"
    remote "rm -rf $there" > /dev/null || true
    return 1
  fi
  remote "cd $there && rm -rf cache && mkdir cache && tar xf send.tar -C cache && nix copy --from file://\$HOME/$there/cache --no-recursive $paths && nix path-info $* > /dev/null && cd && rm -rf $there && { rmdir pi-host-send 2> /dev/null || true; }" > /dev/null ||
    { say "$alias's nix wouldn't take the cache in"; return 1; }
  rm -rf "$work"
  say "$alias holds $*"
}

IFS=: read -ra files <<< "$STORES"
stood=0
failed=0
for file in "${files[@]}"; do
  [[ -s $file ]] || continue
  if [[ $stood == 0 ]]; then
    nix path-info --recursive "$@" > "$scratch/closure"
    stood=1
  fi
  send_to "$(sed -n 1p "$file")" "$@" || failed=1
done
if [[ $stood == 0 ]]; then
  say "no lender stands, so nix-offload copies $* itself when it makes one"
fi
exit "$failed"

#!/usr/bin/env bash
# This machine's nix, as host-send-runtime.test.ts stands it in: it answers
# the closure from $FAKE/closure, naming what it was asked in $FAKE/asked,
# and writes a file cache of the paths it's given, naming them in
# $FAKE/copied, or in $FAKE/referenced for an uncompressed cache. As a
# binary cache does, it refuses a path one of whose references, listed on
# its line of $FAKE/references (`path ref...`), is neither in the cache
# nor among the paths it's given.
case $1 in
path-info)
  echo "$*" >> "$FAKE/asked"
  cat "$FAKE/closure"
  ;;
copy)
  [[ $2 == --to && $4 == --no-recursive ]] || exit 64
  uri=$3
  dir=${uri#file://}
  dir=${dir%%\?*}
  shift 4
  [[ $1 != -- ]] || shift
  hash() {
    local h
    h=$(basename "$1")
    echo "${h%%-*}"
  }
  if [[ -s $FAKE/references ]]; then
    for p; do
      for r in $(awk -v p="$p" '$1 == p { $1 = ""; print }' "$FAKE/references"); do
        [[ -s $dir/$(hash "$r").narinfo ]] || printf '%s\n' "$@" | grep -qxF "$r" || {
          echo "error: cannot add '$p' to the binary cache because the reference '$r' is not valid" >&2
          exit 1
        }
      done
    done
  fi
  mkdir -p "$dir/nar"
  echo "StoreDir: /nix/store" > "$dir/nix-cache-info"
  for p; do
    h=$(hash "$p")
    printf 'StorePath: %s\nURL: nar/%s.nar.xz\n' "$p" "$h" > "$dir/$h.narinfo"
    head -c 3000 /dev/urandom > "$dir/nar/$h.nar.xz"
  done
  if [[ $uri == *compression=none* ]]; then
    echo "$*" >> "$FAKE/referenced"
  else
    echo "$*" >> "$FAKE/copied"
  fi
  ;;
*) exit 64 ;;
esac

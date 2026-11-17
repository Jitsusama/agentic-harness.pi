#!/usr/bin/env bash
# This machine's nix, as host-send-runtime.test.ts stands it in: it answers
# the closure from $FAKE/closure, naming what it was asked in $FAKE/asked,
# and writes a file cache of the paths it's given, naming them in
# $FAKE/copied.
case $1 in
path-info)
  echo "$*" >> "$FAKE/asked"
  cat "$FAKE/closure"
  ;;
copy)
  [[ $2 == --to && $4 == --no-recursive ]] || exit 64
  dir=${3#file://}
  dir=${dir%%\?*}
  shift 4
  [[ $1 != -- ]] || shift
  mkdir -p "$dir/nar"
  echo "StoreDir: /nix/store" > "$dir/nix-cache-info"
  for p; do
    h=$(basename "$p")
    h=${h%%-*}
    echo "StorePath: $p" > "$dir/$h.narinfo"
    head -c 3000 /dev/urandom > "$dir/nar/$h.nar.xz"
  done
  echo "$*" >> "$FAKE/copied"
  ;;
*) exit 64 ;;
esac

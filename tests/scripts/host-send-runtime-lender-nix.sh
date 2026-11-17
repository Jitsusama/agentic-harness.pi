#!/usr/bin/env bash
# The lender's nix, as host-send-runtime.test.ts stands it in: it takes a
# path into its store, $FAKE/lender-store, only from a cache holding its
# narinfo, and names each import in $FAKE/imports and the narinfos the
# cache it was given holds in $FAKE/offered. Given $FAKE/refuse, it
# refuses the cache, as a nix refuses paths no key it trusts signed; given
# $FAKE/broken, it fails once, as when its daemon can't be reached.
case $1 in
copy)
  [[ $2 == --from && $4 == --no-recursive ]] || exit 64
  dir=${3#file://}
  shift 4
  echo "$*" >> "$FAKE/imports"
  (cd "$dir" && ls -- *.narinfo) >> "$FAKE/offered" 2> /dev/null || true
  if [[ -e $FAKE/broken ]]; then
    rm "$FAKE/broken"
    echo "error: cannot connect to socket at '/nix/var/nix/daemon-socket/socket'" >&2
    exit 1
  fi
  [[ ! -e $FAKE/refuse ]] || {
    echo "error: path '$1' lacks a signature by a trusted key" >&2
    exit 1
  }
  for p; do
    h=$(basename "$p")
    h=${h%%-*}
    [[ -s $dir/$h.narinfo ]] || {
      echo "no $p in $dir" >&2
      exit 1
    }
    echo "$p" >> "$FAKE/lender-store"
  done
  ;;
path-info)
  shift
  for p; do grep -qxF "$p" "$FAKE/lender-store" || exit 1; done
  ;;
*) exit 64 ;;
esac

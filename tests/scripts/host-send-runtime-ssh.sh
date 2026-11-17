#!/usr/bin/env bash
# ssh, as host-send-runtime.test.ts stands it in: it runs what it's given in
# the lender's home, $FAKE/lender, and refuses, as a lender remade with a
# new host key is refused, unless it's given the store URI's key and told
# to check the host key strictly against a file naming the lender's alias
# with the key its store URI gives. nix-offload removes its own known-hosts
# file when each run ends, so a send can't lean on that.
#
# Each host it reaches is named in $FAKE/hosts, and each piece it carries
# in $FAKE/uploads. Given $FAKE/allowed, it carries that many pieces and
# then loses every connection that sends one; given $FAKE/cut-once, it
# leaves 10 bytes of one piece under its name and says it went; given
# $FAKE/lose-once, it carries one piece whole and then loses its
# connection, as a link dropped after the copy; given $FAKE/full, the
# lender refuses pieces; given $FAKE/slow, each piece takes 3 s; given
# $FAKE/lose-import, the connection is lost once the lender's nix took the
# cache in; given $FAKE/lose-imports, every connection that would have it
# take the cache in is lost first.
known='' alias='' strict='' ident=''
while [[ $# -gt 0 ]]; do
  case $1 in
  -o)
    case $2 in
    UserKnownHostsFile=*) known=${2#*=} ;;
    HostKeyAlias=*) alias=${2#*=} ;;
    StrictHostKeyChecking=yes) strict=1 ;;
    esac
    shift 2
    ;;
  -i)
    ident=$2
    shift 2
    ;;
  --) shift ;;
  -*) shift ;;
  *) break ;;
  esac
done
if [[ $ident != "$FAKE/key" || -z $strict || -z $alias ]] ||
  ! grep -qxF "$alias $(cat "$FAKE/host-key")" "$known" 2> /dev/null; then
  echo "Host key verification failed." >&2
  exit 255
fi
echo "$1" >> "$FAKE/hosts"
shift
there() { cd "$FAKE/lender" && HOME="$FAKE/lender" PATH="$FAKE/lender-bin:$PATH" bash -c "$*"; }
if [[ $* == *"cat > "* ]]; then
  part=$(sed -E 's/.*cat > ([^ ]+).*/\1/' <<< "$*")
  if [[ -e $FAKE/allowed ]]; then
    left=$(cat "$FAKE/allowed")
    [[ $left -gt 0 ]] || exit 255
    echo $((left - 1)) > "$FAKE/allowed"
  fi
  piece=${part##*/}
  echo "${piece%.part}" >> "$FAKE/uploads"
  [[ ! -e $FAKE/full ]] || {
    echo "No space left on device" >&2
    exit 1
  }
  [[ ! -e $FAKE/slow ]] || sleep 3
  if [[ -e $FAKE/cut-once ]]; then
    rm "$FAKE/cut-once"
    head -c 10 > "$FAKE/lender/${part%.part}"
    exit 0
  fi
  if [[ -e $FAKE/lose-once ]]; then
    rm "$FAKE/lose-once"
    there "$@"
    exit 255
  fi
fi
if [[ $* == *"nix copy --from"* ]]; then
  [[ ! -e $FAKE/lose-imports ]] || exit 255
  if [[ -e $FAKE/lose-import ]]; then
    rm "$FAKE/lose-import"
    there "$@"
    exit 255
  fi
fi
there "$@"

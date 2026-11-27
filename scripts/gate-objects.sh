# shellcheck shell=bash
# What both merge gates judge, read only from objects git hashed as they
# came in. merge-gate.sh and host-gate.sh source it, and gate_objects sets
# main_id and head_id, each found whole in gate_store.
#
# Git never rehashes an object it reads, so a loose object a strict
# session writes into the checkout's object folder under a commit's id
# says whatever it likes (ISXEG8, 27 November): a head made to hold
# main's tree and name main as its parent reads as no change at all, and
# both gates passed it. A fetch is the one read git checks, since
# index-pack hashes every object it takes in. So the gates keep a store
# of their own under pi's state folder, which the fence keeps read-only to
# every session, fetch into it what they judge, and read only from it.
# An object forged in the checkout then hashes to another id, the fetch
# says the commit wasn't sent, and the head is fetched from origin
# instead, or refused where origin doesn't have it.
#
# Main's id is asked of origin itself rather than read from the checkout's
# refs/remotes/origin/main, which a session can write between the gate's
# fetch and its read, and fetched by that id into the store.

gate_home=${XDG_STATE_HOME:-$HOME/.local/state}/pi/agentic-harness.pi/merge-gate
gate_store=$gate_home/objects.git

# Every GIT_ variable the gate was given (a config, a graft file, a
# replace base, an object folder or its alternates) is unset for what
# reads the store, rather than a named few, since each could reach it.
# Bash's own list of the names, since compgen is missing from a bash
# built without completion, and the sweep would then shut out nothing.
inherited=()
for name in "${!GIT_@}"; do inherited+=(-u "$name"); done
unset name

# Git with none of that and no config but the repository's, and only the
# variables given before the command.
clean() {
  env ${inherited[@]+"${inherited[@]}"} GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    GIT_NO_REPLACE_OBJECTS=1 "$@"
}

# Text a head chose (its file names, and what Biome, vitest or git say of
# them) as it may reach the terminal: every control character but a tab
# and a newline goes, escape included, so none can move the cursor,
# retitle the window or hide a line before it.
shown() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }

# Git on the gate's own store, which holds no ref, replacement or graft.
stored() { clean git --git-dir="$gate_store" -c core.hooksPath=/dev/null "$@"; }

# Git asking origin, as the person signs in: their own config and the
# variables that sign in or reach the network stay, and every other GIT_
# variable goes, since one naming an object folder or its alternates
# would take objects from there unhashed.
signing_in() {
  local unset=() name
  for name in "${!GIT_@}"; do
    case $name in
      GIT_ASKPASS | GIT_SSH | GIT_SSH_COMMAND | GIT_SSH_VARIANT | GIT_TERMINAL_PROMPT | \
        GIT_CONFIG_GLOBAL | GIT_HTTP_* | GIT_PROXY_*) ;;
      *) unset+=(-u "$name") ;;
    esac
  done
  env ${unset[@]+"${unset[@]}"} GIT_NO_REPLACE_OBJECTS=1 \
    git --git-dir="$gate_store" -c core.hooksPath=/dev/null "$@"
}

# Fetches `ids` into the store from `from`, a URL or a repository's path,
# by the git that runs it. No ref is written, so the store keeps only
# objects, and an id not among them after is one the fetch didn't bring.
fetched() {
  local by=$1 from=$2
  shift 2
  # An id that isn't a ref's tip is only sent by an upload-pack that
  # allows any: protocol v2 does, an older one is asked to.
  "$by" fetch -q --no-tags --no-write-fetch-head \
    --upload-pack='git -c uploadpack.allowAnySHA1InWant=true upload-pack' "$from" "$@"
}

# Sets main_id to origin's main and head_id to the commit `sha` names,
# both whole in the store, or refuses, saying why, as `gate`.
gate_objects() {
  local gate=$1 sha=$2 url listed checkout said
  if ! (umask 077 && mkdir -p "$gate_home") ||
    { [[ ! -f $gate_store/HEAD ]] && ! clean git init -q --bare --template= "$gate_store"; }; then
    echo "$gate: can't keep the objects it judges in $gate_home, so none can be read as hashed." >&2
    echo "Run it where pi's state folder can be written, outside the agent fence, as review_offer merge does." >&2
    exit 1
  fi
  # The checkout's own config names origin, which the fence keeps from a
  # session.
  url=$(git remote get-url origin)
  if ! listed=$(signing_in ls-remote --exit-code "$url" refs/heads/main) ||
    [[ ! $listed =~ ^([0-9a-f]{40}|[0-9a-f]{64})[[:space:]]refs/heads/main$ ]]; then
    echo "$gate: origin ($url) didn't name its main, so nothing can be judged against it." >&2
    exit 1
  fi
  main_id=${BASH_REMATCH[1]}
  if ! said=$(fetched signing_in "$url" "$main_id" 2>&1) ||
    ! stored cat-file -e "$main_id^{commit}" 2> /dev/null; then
    shown <<< "$said" >&2
    echo "$gate: main's $main_id couldn't be fetched whole from origin, so nothing can be judged against it." >&2
    exit 1
  fi

  # A full id is taken as it stands, and anything else is named in the
  # checkout, past its replacements; either way the store's copy is what
  # counts, and the id is only what it must hash to.
  if [[ $sha =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
    head_id=$sha
  elif ! head_id=$(git --no-replace-objects rev-parse --verify --quiet "$sha^{commit}"); then
    echo "$gate: $sha names no commit here." >&2
    exit 1
  fi
  if ! stored cat-file -e "$head_id^{commit}" 2> /dev/null; then
    # The checkout first, since the head may be nowhere else yet, then
    # origin, which has it where the checkout's copy is forged.
    checkout=$(git rev-parse --path-format=absolute --git-common-dir)
    fetched stored "$checkout" "$head_id" > /dev/null 2>&1 ||
      fetched signing_in "$url" "$head_id" > /dev/null 2>&1 || true
    if ! stored cat-file -e "$head_id^{commit}" 2> /dev/null; then
      echo "$gate: $sha couldn't be fetched whole, from this checkout or from origin, so what it holds can't be read as hashed." >&2
      echo "A forged object in the checkout does this. Push the branch, so origin holds the head, and merge again." >&2
      exit 1
    fi
  fi
  head_id=$(stored rev-parse --verify "$head_id^{commit}")
}

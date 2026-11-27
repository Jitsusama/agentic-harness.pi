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
#
# Each fetch writes a ref of the store's own, refs/gate/commits/<id>,
# which no session can write. A fetch updates a ref only once everything
# under it is there, so a ref names a commit held whole, never one a fetch
# cut short left half-made. A ref is named by its commit, never shared as
# "main", so two gates at once, on two mains, never move or lock each
# other's. The refs are also what a later fetch offers origin as had, so
# each brings only what's new rather than the whole history again, and
# what gc keeps.

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

# Git on the gate's own store, which holds no replacement or graft, and
# no ref but those its own fetches write.
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
        GIT_CONFIG_GLOBAL | GIT_HTTP_* | GIT_PROXY_* | GIT_SSL_* | GIT_CURL_*) ;;
      *) unset+=(-u "$name") ;;
    esac
  done
  env ${unset[@]+"${unset[@]}"} GIT_NO_REPLACE_OBJECTS=1 \
    git --git-dir="$gate_store" -c core.hooksPath=/dev/null "$@"
}

# Fetches `id` into the store's ref `ref` from `from`, a URL or a
# repository's path, by the git that runs it. An id that isn't a ref's
# tip is sent by any upload-pack speaking protocol v2, git's default since
# 2.26 and GitHub's. From a URL the server's own upload-pack runs, since
# over SSH one the gate named would be the command the server runs, which
# GitHub refuses. From a path, the upload-pack runs here, in that
# repository, and would walk its grafts, replacements and commit-graph,
# sending a head's forged parents' objects rather than its own; git clears
# the variables that turn them off for it, so its command names them.
fetched() {
  local by=$1 from=$2 id=$3 ref=$4 own=()
  if [[ -d $from ]]; then
    own=("--upload-pack=env GIT_GRAFT_FILE=/dev/null GIT_NO_REPLACE_OBJECTS=1 git -c core.commitGraph=false upload-pack")
  fi
  "$by" -c protocol.version=2 fetch -q --no-tags --no-write-fetch-head ${own[@]+"${own[@]}"} \
    "$from" "+$id:$ref"
}

# Whether the store's ref `ref` names commit `id`, which only a fetch that
# brought everything under it writes.
holds() {
  local id=$1 ref=$2 named
  named=$(stored rev-parse --verify --quiet "$ref^{commit}") && [[ $named == "$id" ]]
}

# Sets main_id to origin's main and head_id to the commit `sha` names,
# both whole in the store, or refuses, saying why, as `gate`.
gate_objects() {
  local gate=$1 sha=$2 url listed line checkout said
  # git init again on a store that's there only makes what's missing, so a
  # store a first run left half-made is mended, and two first runs at once
  # both end with a whole one.
  if ! (umask 077 && mkdir -p "$gate_home") ||
    ! clean git init -q --bare --template= "$gate_store"; then
    echo "$gate: can't keep the objects it judges in $gate_home, so none can be read as hashed." >&2
    echo "Run it where pi's state folder can be written, outside the agent fence, as review_offer merge does." >&2
    exit 1
  fi
  # The checkout's own config names origin, which the fence keeps from a
  # session.
  url=$(git remote get-url origin)
  # ls-remote matches its pattern as a path's tail, so a ref such as
  # refs/heads/x/refs/heads/main is listed too, and only the line naming
  # refs/heads/main itself is main.
  main_id=
  if listed=$(signing_in ls-remote "$url" refs/heads/main); then
    while IFS= read -r line; do
      if [[ $line =~ ^([0-9a-f]{40}|[0-9a-f]{64})[[:space:]]refs/heads/main$ ]]; then
        main_id=${BASH_REMATCH[1]}
      fi
    done <<< "$listed"
  fi
  if [[ -z $main_id ]]; then
    echo "$gate: origin ($url) didn't name its main, so nothing can be judged against it." >&2
    exit 1
  fi
  # A fetch that fails because another gate is writing the same ref at
  # once still leaves it whole, so the ref, not the fetch, decides.
  said=$(fetched signing_in "$url" "$main_id" "refs/gate/commits/$main_id" 2>&1) || true
  if ! holds "$main_id" "refs/gate/commits/$main_id"; then
    echo "$said" >&2
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
  local held=refs/gate/commits/$head_id
  if ! holds "$head_id" "$held"; then
    # The checkout first, since the head may be nowhere else yet, then
    # origin, which has it where the checkout's copy is forged. What each
    # says is kept, so a fetch that failed for want of a sign-in or the
    # network says so, beside the forgery the refusal names.
    checkout=$(git rev-parse --path-format=absolute --git-common-dir)
    said=$(fetched stored "$checkout" "$head_id" "$held" 2>&1) ||
      said+=$'\n'$(fetched signing_in "$url" "$head_id" "$held" 2>&1) || true
    if ! holds "$head_id" "$held"; then
      echo "$said" >&2
      echo "$gate: $sha couldn't be fetched whole, from this checkout or from origin, so what it holds can't be read as hashed." >&2
      echo "A forged object in the checkout does this. Push the branch, so origin holds the head, and merge again." >&2
      exit 1
    fi
  fi
  head_id=$(stored rev-parse --verify "$head_id^{commit}")
}

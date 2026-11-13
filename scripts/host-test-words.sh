# The words that run test:host on a lent builder, after `nix-offload there`,
# sourced by scripts/host-test-there.sh, which runs them, and by
# scripts/host-gate.sh, which takes only a pass nix-offload kept for these
# very words. Every word is a plain one, and the program is the system's
# bash by its store path, so the agent fence lets the call out from a
# tree the session holds (lib/internal/offload-exemption.ts), and a gate
# working them out again from this machine gets the same words, so long as
# the runtime and tools haven't moved. Another program (true, say) kept as
# passing at the commit matches nothing (ISXEG8, 13 November).
#
# host_test_words RUNTIME [FILE...] fills the array `words`: the runtime,
# the system's bash, mycelium, fd, rg and script(1), each copied up by its
# store folder, then scripts/host-run.sh at the commit with what it runs
# on. Each tool is found in the account's profile, then the system's, or
# in HOST_TEST_PROFILES's folders in their place, never on PATH, which
# differs between a session, a fenced command and the merge gate. With
# files it runs only those, which the gate doesn't count.
# shellcheck shell=bash

# Seconds the lender may take: a few files, or the whole suite (about 20
# minutes).
HOST_TEST_SOME_SECONDS=2400
HOST_TEST_ALL_SECONDS=4200
# A word with no meaning to a shell, as the fence's exemption takes them
# (PLAIN_WORD in lib/internal/offload-exemption.ts). One is also written
# the same in JSON, which host_test_ran counts on.
HOST_TEST_PLAIN='^[A-Za-z0-9._/@:=+^*-]+$'

# The store folder a tool's program is in, through every link, from the
# profiles in turn; nothing, and 1, when none has it.
host_test_tool() {
  local name=$1 profile found
  local profiles=${HOST_TEST_PROFILES:-/etc/profiles/per-user/${USER:-}/bin:/run/current-system/sw/bin}
  local IFS=:
  for profile in $profiles; do
    if [[ -n $profile && -x $profile/$name ]]; then
      found=$(readlink -f "$profile/$name")
      echo "${found%/bin/*}"
      return 0
    fi
  done
  return 1
}

host_test_words() {
  local runtime=$1
  shift
  local bash mycelium fd rg util path longest=$HOST_TEST_ALL_SECONDS
  bash=$(host_test_tool bash) || { echo "host-test-words: no bash in the profiles" >&2; return 2; }
  mycelium=$(host_test_tool mycelium) || { echo "host-test-words: no mycelium in the profiles" >&2; return 2; }
  fd=$(host_test_tool fd) || { echo "host-test-words: no fd in the profiles" >&2; return 2; }
  rg=$(host_test_tool rg) || { echo "host-test-words: no rg in the profiles" >&2; return 2; }
  util=$(host_test_tool script) || { echo "host-test-words: no script(1) in the profiles" >&2; return 2; }
  path="$mycelium/bin:$fd/bin:$rg/bin:$util/bin"
  if [[ $# -gt 0 ]]; then longest=$HOST_TEST_SOME_SECONDS; fi
  words=(--never-ask --run
    --copy "$runtime" --copy "$bash" --copy "$mycelium" --copy "$fd" --copy "$rg" --copy "$util"
    --longest "$longest"
    -- "$bash/bin/bash" scripts/host-run.sh "$runtime" "$mycelium/bin/mycelium" "$path" "$@")
  local word
  for word in "${words[@]}"; do
    if [[ ! $word =~ $HOST_TEST_PLAIN ]]; then
      echo "host-test-words: $word isn't a plain word, which the agent fence won't let out" >&2
      return 2
    fi
  done
}

# The words after `--` that host_test_words filled, as the `"ran":[...]`
# a line of `nix-offload passed ran` holds for them. Each word is plain,
# so it needs no escaping in JSON, and no other line holds this text: a
# longer run goes on with a comma where this one's array ends, and a
# quote within a word would be escaped.
host_test_ran() {
  local at=0 word json=""
  while [[ ${words[$at]} != -- ]]; do at=$((at + 1)); done
  for word in "${words[@]:$((at + 1))}"; do json+="${json:+,}\"$word\""; done
  echo "\"ran\":[$json]"
}

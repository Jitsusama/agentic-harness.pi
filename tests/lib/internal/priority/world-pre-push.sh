#!/usr/bin/env bash
# A stand-in for World's pre-push, as it runs each hook in pre-push.d in
# order, for push-hooks.test.ts to place its hooks under.
set -euo pipefail
export GIT_COMMON_DIR="${GIT_COMMON_DIR-$(git rev-parse --path-format=absolute --git-common-dir)}"
INPUT=$(cat)
for hook in $(find -L "${GIT_COMMON_DIR}/hooks/pre-push.d" -maxdepth 1 -mindepth 1 -type f -perm -u=x | sort); do
  "${hook}" "$@" <<< "${INPUT}"
done

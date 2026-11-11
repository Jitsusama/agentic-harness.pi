#!/bin/sh
# @marker@
# Appends the AI co-author trailer to commits made under this adapter.
# Idempotent and chains to any displaced hook.
#
# Written into a repository's hooks by commit-hook.ts, which fills each
# name between at signs from the adapter's options: its marker, the
# suffix a displaced hook is kept under, the shell test that says this
# commit is the adapter's, and the shell expression giving the trailer.

msg_file="$1"

chained="$(CDPATH='' cd "$(dirname "$0")" && pwd)/prepare-commit-msg.@chainedSuffix@"
if [ -x "${chained}" ]; then
	"${chained}" "$@" || exit $?
fi

@gateTest@ || exit 0
[ -f "${msg_file}" ] || exit 0

if grep -qi 'co-authored-by[: ]*ai' "${msg_file}"; then
	exit 0
fi

git interpret-trailers --in-place --trailer @trailerExpr@ "${msg_file}"

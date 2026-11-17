#!/usr/bin/env bash
# The lender's nix-store, as host-send-runtime.test.ts stands it in,
# answering which of the paths it's given its store, $FAKE/lender-store,
# lacks. Given $FAKE/greedy, it names one more, outside the closure.
[[ "$1 $2" == "--check-validity --print-invalid" ]] || exit 64
shift 2
for p; do grep -qxF "$p" "$FAKE/lender-store" || echo "$p"; done
[[ ! -e $FAKE/greedy ]] || echo /nix/store/9secret-keys

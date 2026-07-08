# Commit Guardian Extension

Intercepts `git commit` commands and presents the commit
message for review before execution.

## What It Does

Every `git commit` gets intercepted. You see the message with
validation indicators (subject length, body wrap, conventional
format) and can approve, edit, steer or reject.

Before the message gate, the guardian refuses the commit while
the verification workflow reports the code is failing, so a red
build does not get committed by reflex. The whole guardian is
skipped when git interception is bypassed, so the bypass toggle
is the escape hatch when that block is wrong or stale.

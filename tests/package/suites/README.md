# Rules the Tests Keep

How the package's own tests are written: an expect says what failed, a
sleep says why, a stop on a timer says why any time will do, a test ends
a renderer by killing it rather than letting it crash, and the host's
suites run alone.

A stop on a timer is any `.abort` or `.kill(` set off by a clock: a
`setTimeout` whose callback stops, an `AbortSignal.timeout`, or a sleep
with a stop within two code lines after it, with any delay but 0. It
passes only with a comment that opens with `any time:` and gives the
reason, on the stop's own lines or just above. Where the stop must land
after something happened, a child started or a request handed over, the
test waits for that with `until` from `tests/support/until.ts` instead.
`sleeps-say-why.test.ts` holds both.

A rule here reads the whole shape of what it looks for, not one spelling
of it, since each rule that read one spelling missed the next. Every
form a rule is known to meet is planted in its own self-test, so a
narrower reading fails there first.

`uncommented-sleeps.txt` lists the sleeps still waiting for their
comment, and only shrinks.

A test makes its folders under `tmpdir()`, which the setup points at the
run's own folder and removes at the end. One it makes in /tmp or
/var/tmp itself is left whenever its own cleanup doesn't run, so
`shared-temp-folders-say-why.test.ts` asks each to say why, on its line
or just above.

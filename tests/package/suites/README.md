# Rules the Tests Keep

How the package's own tests are written: an expect says what failed, a
sleep says why, a stop on a timer says why any time will do, a test ends
a renderer by killing it rather than letting it crash, and the host's
suites run alone.

A stop on a timer, `setTimeout(() => stop.abort(), 200)`, passes only
with a comment holding `any time:` on its line or just above. Where the
stop must land after something happened, a child started or a request
handed over, the test waits for that with `until` from
`tests/support/until.ts` instead. `sleeps-say-why.test.ts` holds both.

`uncommented-sleeps.txt` lists the sleeps still waiting for their
comment, and only shrinks.

# Rules the Tests Keep

How the package's own tests are written: an expect says what failed, a
sleep says why, a test ends a renderer by killing it rather than letting
it crash, and the host's suites run alone.

`uncommented-sleeps.txt` lists the sleeps still waiting for their
comment, and only shrinks.

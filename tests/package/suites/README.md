# Rules the Tests Keep

How the package's own tests are written: an expect says what failed, a
sleep says why, a test ends a renderer by killing it rather than letting
it crash, and the host's suites run alone.

`uncommented-sleeps.txt` lists the sleeps still waiting for their
comment, and only shrinks.

A test makes its folders under `tmpdir()`, which the setup points at the
run's own folder and removes at the end. One it makes in /tmp,
/var/tmp, /private/tmp or /dev/shm itself is left whenever its own
cleanup doesn't run, so `shared-temp-folders-say-why.test.ts` asks each
to say why, on its first line or just above. It reads the path written
in the call, or a constant the same file sets; a path from an import, a
helper or the environment is beyond it.

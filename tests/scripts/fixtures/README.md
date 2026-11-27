# Script Fixtures

Programs a test under `tests/scripts/` runs in a node process of its
own, so that what it proves holds for a process, not a function:

- `fence-child.mts`: pi-fence's run of a command, as `scripts/pi-fence.ts`
  does it, without the fence around it, so a test can signal it and see
  what it leaves running.
- `pi-resume.mts`: `pi --session <id>` as pi's own session manager opens
  it at startup, run in the folder a carried session's node enters, so
  `tests/scripts/pi-carry.test.ts` holds an arrival to what pi resumes
  there, failing where pi would ask a question a held start can't answer.

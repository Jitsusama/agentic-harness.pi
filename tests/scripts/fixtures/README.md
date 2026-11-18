# Script Fixtures

Programs a test under `tests/scripts/` runs in a node process of its
own, so that what it proves holds for a process, not a function:

- `fence-child.mts`: pi-fence's run of a command, as `scripts/pi-fence.ts`
  does it, without the fence around it, so a test can signal it and see
  what it leaves running.

# Carry Test Helpers

What the carry tests share: two homes, one per machine, a bare origin
outside both, and clones of it with commits no remote has, changes never
committed and files never added, all through real git.

- `machines.ts`: the homes, the origin, its clones and commits.
- `arriving.ts`: a session carried into a handover and arrived on the
  other machine, for the tests of arriving.

# Machine

This machine: its name, the realm a session on it lives in, when it
booted, and whether it has room for heavy work now.

## Files

- **`booted.ts`**: when the machine booted, which bounds what is
  still under way.
- **`machine.ts`**: this machine's name as its realm's other
  machines say it, its hostname's short form, and what may be one.
- **`room.ts`**: whether the machine has room now, read from its
  pressure and memory counts: for a council's round, all three bars;
  for a hosted conversation's roll, the CPU alone.
- **`realm.ts`**: which realm a session lives in, set by
  `MYCELIUM_REALM` as it starts, and where that realm keeps its own
  beside the machine's home realm.

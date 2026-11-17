# Machine

This machine: its name, the realm a session on it lives in, and when
it booted.

## Files

- **`booted.ts`**: when the machine booted, which bounds what is
  still under way.
- **`machine.ts`**: this machine's name as its realm's other
  machines say it, its hostname's short form, and what may be one.
- **`realm.ts`**: which realm a session lives in, set by
  `MYCELIUM_REALM` as it starts, and where that realm keeps its own
  beside the machine's home realm.

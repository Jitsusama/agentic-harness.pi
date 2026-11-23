# Script Test Helpers

What the tests of a script share across their files: check-there.sh's
cases, kept in one place so each lock tool's turns can run in a file of
its own, side by side. They import the script as text, through the
`?raw` that `raw.d.ts` declares, so a change to the script alone still
runs them under `pnpm check`.

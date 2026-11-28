# Rules the Code's Layout Keeps

How the code is laid out: a domain owns its seams, a helper lives once, a
relative import names its `.ts` file, a program lives in its own file,
a long file says why it is long, an empty catch says why its error can
go, a linter is turned off no more often
than before, a test imports each shell script it runs, and googleapis' types come from each API's own module, so a
typecheck reads six APIs rather than 328, and the model providers'
SDKs stay out of it.

Three lists wait here and only shrink: `long-files-waiting.txt`, the long
files not yet split, `suppressions-waiting.txt`, each file's suppression
comments not yet fixed away, and `embedded-programs.txt`, the programs
still written inside another file. Nothing imports the first two rules
for `pnpm check` to reach, so `scripts/merge-gate.sh` runs main's copy of
them at every merge, with main's `package-files.ts`, which lists the
package's files for both as code-health does. They judge the tree the
merge would make, so a line main took off since a branch was cut stays
off.

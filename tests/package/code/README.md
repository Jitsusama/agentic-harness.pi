# Rules the Code's Layout Keeps

How the code is laid out: a domain owns its seams, a helper lives once, a
relative import names its `.ts` file, a program lives in its own file,
a long file says why it is long, and googleapis' types come from each
API's own module, so a typecheck reads six APIs rather than 328.

Two lists wait here and only shrink: `long-files-waiting.txt`, the long
files not yet split, and `embedded-programs.txt`, the programs still
written inside another file.

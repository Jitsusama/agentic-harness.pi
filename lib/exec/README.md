# `lib/exec`

Running a command, taken as a dependency instead of imported.

## Why It Exists

Both of the libraries that talk to a command line need the same thing. A review
provider reaches its backend by running a CLI; the working layer reaches git the
same way. Passing that capability in rather than importing pi's own exec is what
makes either one testable, and what lets another package use them.

It used to live under `lib/review/providers`. That was true while review was its
only caller, and stopped being true when `lib/work` arrived: the working layer
imported the type out of the reviewing layer's provider folder, which reads as a
dependency between two domains when the only shared thing is the shape of a
subprocess. Neither owns it, so it sits on its own.

`lib/review` still re-exports `Exec` and `run`, because downstream packages import
them from there and a move is not a reason to break them.

## What Is Here

| Export | What it is |
|---|---|
| `Exec` | Runs a command, answering rather than throwing |
| `ExecResult` | The code and both streams |
| `ProviderDeps` | What a provider factory takes |
| `run` | Runs a command and throws with the backend's own words |

## Notes

`run` keeps both streams when both said something. They carry different halves of
the same answer, and the useful half was being thrown away: `gh api` writes its
summary to stderr and the server's response body to stdout, so preferring stderr
reduced a 422 naming the exact offending field to `gh: Unprocessable Entity (HTTP
422)`, which is a complete sentence about nothing.

There is no `cwd` here on purpose, and it is a sharp edge worth knowing. A caller
that needs a command scoped to a directory has to say so in the arguments, which
for git means `-C <path>`. Forgetting it does not fail; the command runs wherever
the process happens to sit and answers confidently about the wrong repository. That
shipped as a real bug once.

# Pineapple Workflow

Holds Joel's safe word at the one place a model can't talk past: its
own tool calls.

## Why

On 13 November a colleague tagged Joel with "pineapple override" to
stop his agents pushing to a pull request in a merge queue. Nothing
read it, and one session saw it only by luck. A mesh hold alone is a
request a model can misread; a refused tool call is not.

## What It Refuses

Core's pineapple reader writes a stop under
`$XDG_STATE_HOME/pineapple/stops/`, one JSON file each, naming what it
reaches. While a stop stands and isn't marked shadow, this refuses the
writes it reaches:

- pushes: `git push`, `dt push`, `dt submit` and the work tool's push;
- pull-request writes: `gh pr` and `dt pr` create, edit, comment,
  review, ready, close, reopen, merge and the like, `gh api` calls
  that change a pull request or issue, and the review tools'
  `review_offer`, `review_say` and a published `review_draft`;
- switches and deploys (`switch-system`, `nixos-rebuild switch` and
  the like), for a stop on a realm or everything only.

What a stop reaches, by its record's `reaches`:

| Reach | Holds |
| --- | --- |
| `pr:owner/name#12` | writes to that change, or a push to its branch |
| `branch:owner/name@b` | writes to that branch |
| `repo:owner/name` | writes to that repository |
| `quest:ID` | writes from a session whose quest is it or under it |
| `realm:work` | writes from a session in that realm, switches too |
| `named:word` | writes whose repository, branch or folder carries the word |
| `everything` | every write |

A tool called from a codemode script is judged like any other, since
pi passes nested calls through `tool_call` too.

Reads, builds, commits and edits in a session's own tree are never
refused, so a stop on one pull request leaves the session its other
work.

When the guard can't tell a write apart from what was stopped, a bare
push whose branch GitHub won't name, say, it refuses and says why.
Joel's rule is to lean toward stopping; the refusal says to name the
change or repository, which is all a write outside the stop needs.

Only Joel resumes a stop, outside pi. The guard is `pineapple` in
`/guards` and blocks by default, so a refused call made again is
refused again.

## Shadow

A stop the reader marks shadow refuses nothing. Each write it would
have refused is written to
`$XDG_STATE_HOME/pineapple/would-refuse.jsonl`, with the stop and the
reason, so Joel can read two days of it before anything is enforced.

## Cost

With no stop standing, a call that writes looks once at an empty
folder and a call that doesn't write looks at nothing. A stop on one
pull request asks GitHub (then Delta) once a session for that change's
branch, to tell a push to it from any other.

## Not Covered

- Writes through a program this doesn't know, such as a script that
  pushes; a mesh hold and parking cover those.

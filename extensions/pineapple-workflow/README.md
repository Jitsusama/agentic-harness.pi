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

## Parking

A stop wider than one change parks the sessions it reaches: the turn
under way finishes, and a run nobody typed (a peer's question, a
background job's result, a steer) ends as it starts. A quest parks the
sessions on it or under it, a repository those with its clone or a
tree of it, a realm its sessions, and `named:` those whose repository,
folder or quest carries the word. A stop on one pull request or branch
parks nobody.

What Joel types still runs, since a safe word that stopped him working
would break what it protects; the write guard still holds every write
the stop reaches. This is the session parking itself rather than a
steer's pause, because a pause ends when the person talks to it and a
stop must not.

Once the stops parking a session are resumed, it carries on within a
minute, told to check what changed where the stop stood before it
writes.

## Holds

Each stop sends a mesh hold from the address `PINEAPPLE`, to the
narrowest groups its work is in: `#quest/...` for a quest, `#repo/...`
for a repository or a change in one, and `#all` otherwise. It says
who said what and where, what it stops, and asks each session to say
what it was doing there. It is renewed every 100 minutes, inside the
mesh's two hours, and ended with a note once Joel resumes the stop.
A stop on another realm is left to that realm's sessions.

Every session tends the holds on a one-minute clock, one at a time
by a claim file under the mesh's state, so they go out while any
session runs.

## Joel's Records

No agent changes the safe word's records under
`$XDG_STATE_HOME/pineapple/`, stop or no stop: an edit or write
there, or a command naming the folder that isn't plainly a read, is
refused, and so is any `pineapple resume`. Reading goes on: `cat`,
`ls`, `jq`, `find` without `-delete` or `-exec`, `pineapple stops`
and `pineapple-slack heard`.

## Shadow

A stop the reader marks shadow refuses, parks and holds nothing. What
it would have done is written beside the stops, so Joel can read two
days of it before anything is enforced:

- `would-refuse.jsonl`: each write, with the stop and the reason;
- `would-park.jsonl`: each session it would have parked, once;
- `would-hold.jsonl`: each hold it would have sent, once a renewal.

A live stop writes `parked.jsonl` the same way, each session it parked,
once, so the launcher's row for the stop can say how many sessions
wait on Joel's resume.

## Cost

With no stop standing, a call that writes looks once at an empty
folder and a call that doesn't write looks at nothing; a run's start
and each turn's end look once more, and so does the one-minute clock.
Only a stop on a repository or a name asks git for the session's
repositories, at each of those looks. A stop on one
pull request asks GitHub (then Delta) once a session for that change's
branch, to tell a push to it from any other.

## Not Covered

- Writes through a program this doesn't know, such as a script that
  pushes; a mesh hold and parking cover those.
- Merges already queued: they are left alone, since pushing to a
  queued change can throw it out of the queue.
- Sessions running older code, which neither refuse nor park; the
  hold reaches those.

# lib/result

Tool answers that are bounded without being lossy.

A tool with a large payload has always had two bad options: spend
the caller's context on all of it, or cut it and lose the part
that mattered. This library is the third option. The payload goes
to a session store under an opaque handle, the answer carries a
bounded view plus a digest of the shape, and one query language
reaches everything that was not shown.

## The Bargain

| Piece | Answers |
|---|---|
| `store.ts` | Where a payload lives and how a handle resolves |
| `spill.ts` | Writing a payload without ever overwriting another |
| `digest.ts` | What a payload is shaped like, in a few hundred bytes |
| `query.ts` | What a caller asked of it, in JSONPath |
| `cite.ts` | Whether a handle is worth citing at all |
| `listing.ts` | Bounding a rendered list, and what must survive the cut |
| `details.ts` | The same bargain for a family that answers with a record set |
| `view.ts` | Cutting text to a budget by whole lines |
| `counts.ts` | Writing a number the same way on every machine |
| `follow.ts` | Whether anything in this process can read a handle back |
| `location.ts` | Which directory this session owns, and when it is reaped |

## The One Rule

Cite a handle exactly when the stored payload holds more than the
inline view shows. Citing on every answer trains a reader to skip
the line, which is the same as not printing it. Citing only when
asked requires the caller to know in advance that the page was
enormous, which is what they called to find out.

`cite()` owns that decision so no family makes it differently. A
tool that decided for itself would drift: one citing at a
kilobyte, another at a megabyte, a third forgetting, and the
caller learning each one's habits instead of the rule.

"More than the inline view shows" is not the same question as
"did the budget cut this", and keying on the second is a bug this
library shipped once. An audit report prints five example
elements per rule and counts the rest: nothing was cut, every
line it meant to write got written, and eight thousand elements
were still missing. A family that elides on its own account says
so with `elided`, and the citation is raised on either ground.

## A Handle Nobody Can Read Is Worse Than No Handle

The tools that mint handles and the tool that reads them are
separate extensions, each loadable alone. A citation therefore
names its reader only when one has been offered, through
`offerQueryTool`, and otherwise says plainly that the handle
cannot be followed and which extension would follow it. The
digest is printed either way, since the shape is what tells a
reader whether loading that extension is worth the trouble.

The offer lives on a `globalThis` slot rather than in a module
variable. Pi loads each extension separately, so a module
variable is not process-global here: the copy the store extension
wrote to was not the copy the browser extension read from, and
every citation claimed no reader existed in sessions where one
did.

## The Store Is Its Directory

Handles resolve against the directory, not against an in-memory
index. Several extensions in one process hold their own store
instances over the same directory: the browser tools put a page
outline, the query tool reads it back. An index would have made a
handle readable only by whoever wrote it, which is the one thing a
handle is for.

The quota counts what is on disk for the same reason. A quota each
instance enforced privately would be the quota multiplied by
however many instances there happened to be.

A handle arrives from a language model, so it is validated before
it reaches the filesystem. The check is that the name cannot
escape the directory, not that this library minted it: the
directory may hold another tool's payloads, and refusing to read
anything unfamiliar would make the store useless for the sharing
it exists to allow.

Ownership is the stricter question and is asked separately. Only
names matching the shape this library mints are counted against
the quota or chosen for eviction, because a quota enforced by
deleting other people's files is not a quota. For the same
reason a store has no `clear()`: emptying a shared directory
would take handles other extensions had just given out and are
about to be asked to read. Tearing a session down belongs to
`cleanupSessionResults`, which owns the directory rather than one
name inside it.

A payload that is present but unreadable is not an expiry. Only a
missing file expires a handle; a permission error or a full disk
is reported as itself, since telling a caller their handle
expired sends them to re-run the work that produced it, which
will fail the same way.

## What This Library Does Not Do

It does not decide how large an inline view should be. That is the
family's business: `lib/web` has its own budgets and its own
vocabulary for narrowing a page read, and narrowing at the source
is always better than querying a payload that should never have
been that size.

## Tests

`tests/lib/result/` covers the store's cross-instance resolution
and traversal refusal, the citation rule in both directions, the
query language's bounds and its teaching errors, and the reaper's
refusal to touch a live session's payloads.

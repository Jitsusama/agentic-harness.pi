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

A handle arrives from a language model, so it is validated against
the shape this library mints before it reaches the filesystem.
Anything else is not a handle and is refused.

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

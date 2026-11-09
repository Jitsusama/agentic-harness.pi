# result-store-workflow

Owns the session's result store and registers the one tool that
queries it.

Tools in this package that can answer with a large payload keep the
whole payload on disk and hand back a bounded view plus a handle.
This extension is the other half of that bargain: `result_query`
turns a handle back into an answer, and the session lifecycle
decides how long a handle is worth citing.

## Why One Tool

The cost of a query language is learning it, and that cost is paid
once only if the language does not change depending on who stored
the payload. A browser page outline, a Slack thread, a Google
document and a language-server reference list are all queried the
same way:

```text
result_query handle:result-1a2b3c4d5e6f7a8b expression:"$.nodes[?(@.role=='button')].name"
```

The alternative, a query verb inside each family, fragments the
language and collides with names that already mean something else:
`browser_see kind=query` searches a live page, not a stored answer.

## Lifetime

Each session has its own directory below the process directory,
with its own 256 MiB quota. Writers and result_query pass the caller's
context when opening it. Quitting removes only that session's results;
another runner in the same process keeps its handles. The next start
reaps entire directories whose process is gone.

Only a quit deletes it. pi also says shutdown for a reload, a new
session, a resume and a fork, and none of those end the process; a
reload leaves the conversation on screen citing the handles it was
given, which would otherwise all answer as missing.

When a live process upgrades from the old process-only layout, startup
copies only the legacy handles already cited in that conversation's
branch. Uncited legacy payloads stay outside the new store. Originals
remain for other pre-upgrade conversations until dead-process reaping.

A handle lasts until its session quits, its process dies or its quota
evicts the payload. `result_query` says so plainly when a handle has expired
rather than returning an empty answer that reads like "no data".

## Why `-workflow`

It owns session-scoped state and registers a tool over it. That is
not quite any existing contract: `-integration` bridges an
external service, and there is no service here. `-workflow` is the
closest fit on the strength of the session lifetime, and the
taxonomy's rule is that the primary behavioural contract wins.

## Files

| File | Holds |
|---|---|
| `index.ts` | Tool registration and session lifecycle |
| `render.ts` | How a query reads in the transcript |

The store, the query language, the digest and the citation rule
all live in the package's [result library][result]; this extension is
its session-lifetime adapter.

[result]: ../../lib/core/result/index.ts

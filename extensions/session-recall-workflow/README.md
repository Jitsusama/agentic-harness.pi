# session-recall-workflow

Registers `session_recall`, which searches the session's own log or
reads one entry of it by id.

A compaction keeps a summary and a recent tail in the context, and
everything else leaves it while staying on disk. This tool is how the
model gets that back. Replays of twenty real sessions scored better on
questions about the earlier work with it than without, whatever summary
the session had.

## How It Answers

- **Search** matches any word of the query, not the phrase, because a
  model asks in its own words and the log almost never holds them as
  one string. Rarer words count for more, so a file name outranks the
  everyday words around it. Each hit shows about 900 characters around
  its first match, under the entry id that reads it in full.
- **A tool call reads with its result,** under the assistant entry that
  made it, since each alone answers half a question. The tool's own
  earlier calls are left out, or every search would find the last
  one's hits again.
- **A page holds ten hits or about 4k tokens,** whichever comes first.
  Recall lands in the room a compaction just made, and an unbounded
  answer could put back enough to bring on the next one. What a page
  leaves out is stored through the result store and cited by handle,
  and the page names the ids it left for later.

The branch is what it searches: the path from the root to where the
session is now, which is the history the summary was written over.

## The Summary Note

Every summary the harness writes ends with one line saying the log can
still be searched, contributed through the compaction workflow's
`SUMMARY_CONTRIBUTIONS`. A model that has just lost its history has no
other reason to go looking for it. A summary pi writes itself, when
the harness's summariser declines, carries no contributions and so no
note; the tool is still registered and described.

## Why `-workflow`

It registers a tool over session-scoped data and contributes to the
compaction workflow, which is the same reading the result store took:
`-integration` bridges an external service, and there is none here.

## Files

| File | Holds |
|---|---|
| `index.ts` | Tool registration, bounding and the summary note |

The search itself is pure and lives in `lib/internal/recall/`.

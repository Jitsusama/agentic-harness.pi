---
name: result-query-guide
description: >
  How to read a tool answer that cites a stored handle, and how to
  query it with the shared JSONPath language through result_query.
  Covers when to query rather than re-run, projecting versus
  returning whole records, counting without fetching, filtering,
  and what the payload of each tool family looks like. Use when a
  tool answer says part of its payload is stored, when asked to
  "query that result", "get the rest of it", "how many of those
  were there", or when an answer looks truncated.
---

# Querying a Stored Tool Output

Tools that can answer with more than they can show keep the whole
payload on disk and cite it:

```
All 18,004 outline lines are stored under handle
result-1a2b3c4d5e6f7a8b; this answer shows 96. Query the rest with
result_query, projecting the fields you want rather than whole
records. Shape: {url:string(52), title:string(31),
nodes:array(18004, first={role:string, name:string, states:array})}
```

Three things are on offer there: the handle, the shape, and the
number. Read the shape before writing an expression; it names the
fields, and a query that guesses a field name comes back empty.

## Query, Do Not Re-Run

When an answer cites a handle, the payload is already captured.
Calling the tool again costs another round trip, may return
something different because the page or the thread moved, and
still will not show the part you wanted. Query the handle instead.

Re-run only when you need something the payload does not contain:
a different page, a later moment, a wider capture.

## Project, Do Not Return Records

The expression decides how much comes back. Ask for fields:

```
$.nodes[0:20].name                     the first twenty names
$.nodes[?(@.role=='button')].name      every button's name
$.requests[?(@.status>=400)].url       what failed
$.messages[?(@.user=='U123')].text     one person's messages
```

Not the records around them:

```
$.nodes[*]           every node, whole, which is what the store
                     was avoiding
```

`$..*` deserves its own warning: it matches every value at every
depth, which on a large payload is the entire thing flattened.

## Counting Is Free

The reply opens with the total number of matches before any cap,
so a deliberately broad expression answers "how many" without
pulling the records:

```
$.nodes[?(@.role=='heading')]     "412 matches; showing the first 100."
```

Use that to decide whether a narrower question is needed, and to
answer questions that are only about counts.

## When Nothing Matches

An empty result is almost always a name, not an absence. Field
names are case-sensitive. A field name containing dots is a single
literal key, so reach it with bracket notation:

```
$.timings[?(@['dns.lookup']>100)]
```

The tool says so when a query finds nothing, along with the
reminder to check the shape.

## Handles Last One Session

The store is scoped to the session that minted the handle, and is
deleted when that session ends. A handle from an earlier session
reports that it is no longer available rather than returning an
empty answer, so an expired handle is never mistaken for missing
data. If you need a payload again after that, re-run the tool.

## What Each Family Stores

| Family | Payload |
|---|---|
| `browser_see`, `browser_do`, `browser_go` | The page's accessibility tree: `nodes` of `role`, `name`, `states`, nested by `children` |
| `browser_see kind=requests` and telemetry | Request, log, download and announcement records |
| `browser_check` | Findings with their rule, impact, criterion and elements |
| `slack` | Message records with `user`, `text`, `ts`, `thread_ts` |
| `google` | Message and document records |
| `lsp` | Locations with `path`, `line`, `character` |
| `pr_workflow` | Findings and review threads |
| `subagent` | Per-subagent results |

Reading the cited shape is always more reliable than this table:
the shape came from the payload in front of you.

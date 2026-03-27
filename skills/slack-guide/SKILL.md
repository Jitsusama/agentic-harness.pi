---
name: slack-guide
description: >
  Access Slack: search messages, read threads, send messages,
  look up users and channels, manage reactions. Use when asked
  to "check Slack", "find messages", "search Slack", "send a
  message", "what did X say", "show me the thread", "who is",
  "react to", or any query about Slack messages, channels or
  users.
---

# Slack

Access Slack through the `slack` tool. Translates natural
language requests into structured API calls.

## Authentication

User must run `/slack-setup` once to authenticate. Credentials
persist across sessions. The tool auto-prompts if not set up.

## User Identity

The extension tracks the authenticated user's Slack handle in
session state. Once populated, it's injected into agent context
automatically so you always know who you're acting on behalf of.

**First session**: call `get_user` with the user's handle early
in the conversation to verify identity and populate the session
state. Don't guess handles from project context; verify them.

**Subsequent sessions**: the identity is restored automatically.
Use the known handle for `from:` queries without re-verifying.

## Core Principle: Present Results, Don't Parrot

After a tool call returns, **summarise the results conversationally**.
Don't just say "here are the results" — the user already sees
the collapsed tool output. Add value by highlighting what matters:

- Name the people involved and what they said
- Call out the key topic or decision
- Note dates/timing if relevant
- Mention thread depth or follow-up if the user might want more

**Bad:** "Here are your last 5 messages to Chao Duan."
**Good:** "Your last 5 messages to Chao Duan were yesterday evening,
discussing M5 risk areas and an upcoming call. You offered to help
with triaging issues."

## Translating User Intent

### "Check Slack for X" / "Search Slack for X"
→ `search_messages` with `query: "X"`

### "Messages from [person]" / "What did [person] say"
→ `search_messages` with `from: "person"` (and optionally `query`)
- Use the person's Slack handle (first.last format)
- `query` is optional when structured params (`from`, `with`,
  `channel`, `after`, `before`) are present — it defaults to `*`

### "Messages in [channel] about X"
→ `search_messages` with `query: "X"` and `channel: "channel-name"`

### "Messages I sent to [person]"
→ `list_messages` with the person's user ID as `channel`,
  then filter output to messages from the authenticated user.
  Falls back to `search_messages` with `from: "me"` and
  `with: "person"` when keyword filtering is needed, but
  note that search results include shared channels.

### "My DMs with [person]" / "Conversations with [person]"
→ **Always** use `list_messages` with the person's user ID
  as the `channel`. The resolver calls `conversations.open`
  to find the DM channel automatically. This returns only
  DM messages — complete and in order.

  **Do not** use `search_messages` with `with:` for DM
  history. Search mixes in shared channel results, misses
  messages the index doesn't match, and is unreliable for
  comprehensive queries. Only use `with:` when you need
  keyword filtering across all conversations (DMs, group
  DMs and channels together) and tell the user the results
  include shared channel messages.

  To get the user ID, call `get_user` first if you only
  have a handle.

### "Last thread I started in [channel]"
→ `search_messages` with `from: "me"` and `channel: "channel-name"`
  Slack has no "thread parent only" operator. `is:thread`
  matches replies too. To find threads the user *started*,
  look for messages with `[N replies]` in the output — these
  are thread parents. Messages without a reply count are
  either top-level posts with no thread or replies within
  someone else's thread.

### "Show me the thread" / "Get the full thread"
→ `get_thread` with `target: "permalink_url"` from previous results
- Always prefer the permalink URL from search results

### "What's happening in #channel" / "Last N messages in #channel"
→ `list_messages` with `channel: "channel-name"` and a `limit`
  This uses `conversations.history`, which returns every
  message in the channel. Pass `limit: 0` for unlimited.
  **Always use `list_messages` for channel history**, not
  `search_messages`. Slack's search index doesn't guarantee
  returning every message; a wildcard query like `*` will
  miss messages that the indexer doesn't match.

### "Who is [person]"
→ `get_user` with `user: "person"` (handle or @handle)

### "Tell me about #channel"
→ `get_channel` with `channel: "channel-name"`

### "Send [person/channel] a message saying…"
→ `send_message` with `channel` and `text`
- The user sees a confirmation gate before it sends

### "Reply to that thread saying…"
→ `reply_to_thread` with `channel`, `ts` (from previous context), and `text`

### "React to that with :emoji:"
→ `add_reaction` with `target` or `channel`+`ts`, and `emoji`

### Ambiguous Date Ranges

When the user says "last 3 months", "recently" or "this
quarter", state the exact date range you're using (e.g.,
"Searching from December 27 to today") so the user can
correct it if it doesn't match their intent.

### "Messages I reacted to" / "Where did I react"
→ Multiple `search_messages` calls, one per common emoji.
  Use `hasmy::thumbsup:`, `hasmy::heart:`, `hasmy::fire:`,
  etc. as the query. See "Enterprise Grid Limitations" for
  the full approach.
  **Do not** try `hasmy:reaction` — it returns nothing.

## Search Operators

Slack search supports these operators embedded in the `query`:
- `from:username` — messages from a person
- `to:username` — direct messages to a person
- `with:@person` — DMs and threads with a specific person
  (also available as the `with` parameter)
- `in:#channel` — messages in a channel
- `has:reaction` — messages that have **any** reaction on them
  (from anyone). Does NOT mean "messages I reacted to."
- `has:link` / `has:pin` — message properties
- `hasmy::thumbsup:` — messages **you** reacted to with a
  **specific** emoji. There is no wildcard form: `hasmy:reaction`
  does NOT work. You must name the exact emoji.
  Do not confuse with `has:reaction` which is unrelated.
- `is:thread` — only thread messages
- `is:saved` — your saved items
- `after:YYYY-MM-DD` / `before:YYYY-MM-DD` — date range.
  **These are exclusive**: `after:2026-03-26` means messages
  from March 27 onward, not from March 26. To include today,
  use yesterday's date.
- `on:YYYY-MM-DD` — exact date
- `during:month` / `during:year` — relative dates (e.g. `during:march`)
- `"exact phrase"` — quoted exact phrase match
- `term -excluded` — exclude results containing a word
- `rep*` — wildcard prefix match (min 3 characters)

Structured parameters (`from`, `with`, `channel`, `after`,
`before`) get appended as operators to the query string.

**No "starts with" operator**: Slack search matches a phrase
anywhere in the message body, not just at the start. When
the user asks for messages starting with a phrase, search
for that phrase and tell the user that results include any
message containing it. Post-filtering on returned text is
approximate since message text in results may be truncated.

## URL and ID Handling

- **Permalink URLs**: pass directly as the `target` parameter.
  Works for `get_message`, `get_thread`, `get_reactions`,
  `reply_to_thread`, `add_reaction`, `remove_reaction`.
- **Channel names**: with or without `#`. Resolved automatically.
- **User handles**: with or without `@`. Resolved automatically.
- **Timestamps**: the `ts` field from previous results.

## Context Management

### Remember Previous Results

After `search_messages`, remember the message list. The user
may say:
- "Show me the thread for the first one" → use the permalink
- "What's the context for that third message" → get_thread
- "Reply to that" → use channel + ts from the message

After `list_messages` in a channel, the user may say:
- "What's that thread about" → get_thread with a ts
- "Send a reply" → reply_to_thread

After `get_user`, the user may ask:
- "Send them a message" → use the user's DM channel

### Thread Navigation

The most common follow-up after a search is reading a thread.
When results show messages with thread context, proactively
mention that threads are available.

## Response Formatting

When presenting results to the user:

1. **Lead with a summary**: "Found 5 messages from you to
   Chao Duan, all from yesterday evening."
2. **Highlight the substance**: what topics, decisions, or
   requests appear in the messages.
3. **Offer next steps**: "Want me to pull up the full thread
   for any of these?" or "Should I reply to that?"

Don't re-list every message — the tool output already shows
them. Add interpretation and context the raw output doesn't
provide.

## Pagination

The tool auto-paginates internally for `search_messages`,
`search_files` and `list_messages`. You don't need to manage
pages yourself; just set the `limit` parameter and the tool
fetches as many pages as needed.

- **Default limit**: 20 results. Fine for quick lookups.
- **"Show me all"**: pass `limit: 0` for unlimited results.
- **Specific count**: pass any number. `limit: 1000` fetches
  up to 1000, paging through internally.

**When the user asks a question that requires comprehensive
data** (e.g. "how many times did I…", "find all messages
about…", "what did I say over the past N months"), **always
pass `limit: 0`** with appropriate `oldest`/`latest` params.
The default limit of 20 is useless for these queries. Drawing
conclusions from partial data is worse than fetching too much.

For search results, when the total exceeds what was fetched,
the output says so. Relay this to the user and offer to fetch
the rest with a higher limit.

## Efficiency: Minimise Tool Calls

The Slack API has no "top DM partners" or "most active
channels" endpoint. Complex questions require creative
querying. Aim to extract maximum information from each call.

**Use `list_messages` for DM history**: pass the person's
user ID as the `channel` — it resolves to the DM
automatically via `conversations.open`. This returns only
DM messages, complete and in order. Use `with:` on
`search_messages` only when you need keyword filtering
across DMs *and* shared channels.

**Batch over serial**: a single `search_messages` with 100
results gives you channel IDs, user IDs, timestamps and
text. Extract patterns from that data before making more
calls. Don't look up each user or channel individually
unless you need details beyond what the search gave you.

**User IDs are auto-resolved**: the tool resolves raw Slack
user IDs (U08ME9KASG7) to @handles automatically. You don't
need to call `get_user` just to learn someone's name — it
already appears in message output.

**Channel kinds are resolved automatically**: each message
includes a `channelName` and `channelKind` field. Kinds are
`dm` (1:1 direct message), `group_dm` (multi-person DM),
or `channel` (public or private channel). Use these to
filter results instead of guessing from channel ID prefixes.

**Use search operators aggressively**: combine operators to
narrow results. `from:me with:@person after:2025-03-01` is
far more efficient than broad searches filtered after the
fact.

**For "who do I DM most"**: search `from:me` with a high
limit. Each result has `channelKind` set to `dm`, `group_dm`
or `channel`. Filter to `dm` and `group_dm` entries and
count by channel to rank DM partners. Channel names show
who the DM is with (e.g. "DM with @chao.duan" or "Group DM
(@chao.duan, @xiao.li, @henrique.andrade)").

## Enterprise Grid Limitations

Some Slack APIs are blocked on enterprise workspaces even
with browser session tokens:

- **`reactions.list`**: blocked (`not_allowed_token_type`).
  Cannot list all messages a user reacted to.
- **`users.conversations`**: blocked (`enterprise_is_restricted`).
  Cannot list DM channels or group DMs.
- **`conversations.list`**: blocked. Cannot enumerate channels.

These limitations mean some queries require creative
workarounds through search. Never fall back to raw shell
commands or curl — always use the tool's search actions.

### "Messages I reacted to" / "Where did I react"

The `hasmy::emoji:` operator requires a specific emoji name.
There is no wildcard. Search common emojis individually:

```
hasmy::thumbsup: after:2025-03-20
hasmy::heart: after:2025-03-20
hasmy::fire: after:2025-03-20
hasmy::joy: after:2025-03-20
hasmy::raised_hands: after:2025-03-20
hasmy::tada: after:2025-03-20
hasmy::100: after:2025-03-20
```

Run multiple `search_messages` calls with these queries.
Deduplicate across results and filter by `channelKind` if
the user asks about DMs specifically.

**Warn the user** that this only covers common emojis. Custom
or unusual reactions may be missed.

## Common Mistakes to Avoid

**DON'T** just echo "here are the results":
```
# ❌ Bad
"Here are your last 5 messages to Chao Duan."

# ✅ Good
"Your recent conversation with Chao Duan (yesterday evening)
was about M5 risk areas — you offered to help triage issues
and mentioned having a call scheduled. Want me to pull up
the full thread?"
```

**DON'T** forget context from previous results:
```
# ❌ Bad: asking for a URL the results already provided
"What's the thread URL?"

# ✅ Good: use the permalink from the search result
slack({ action: "get_thread", target: "https://...permalink..." })
```

**DON'T** pass raw user IDs when the user gave a name:
```
# ❌ Bad
slack({ action: "get_user", user: "U08ME9KASG7" })

# ✅ Good
slack({ action: "get_user", user: "joel.gerber" })
```

**DON'T** fall back to raw curl or shell commands when an API
is blocked. Use the tool's search actions creatively instead.
The user should never see curl scripts in the output.

**DON'T** use `search_messages` to get channel history:
```
# ❌ Bad: search index doesn't return all messages
slack({ action: "search_messages", query: "*",
        channel: "privacy-engineering", limit: 1000 })

# ✅ Good: conversations.history returns every message
slack({ action: "list_messages",
        channel: "privacy-engineering", limit: 1000 })
```

**DON'T** try non-existent search operators:
```
# ❌ These don't exist
hasmy:reaction
has:myreaction

# ✅ Must name a specific emoji
hasmy::thumbsup:
hasmy::heart:
```

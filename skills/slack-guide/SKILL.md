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
→ `search_messages` with `query` and `from: "person"`
- Use the person's Slack handle (first.last format)

### "Messages in [channel] about X"
→ `search_messages` with `query: "X"` and `channel: "channel-name"`

### "Messages I sent to [person]"
→ `search_messages` with `with: "person"` and `from: "me"`

### "My DMs with [person]" / "Conversations with [person]"
→ `search_messages` with `with: "person"` (no `from` filter)
  Returns both sides of the conversation. Results include
  DMs, group DMs and shared channels — use `channelKind` to
  filter to just DMs if needed.

### "Show me the thread" / "Get the full thread"
→ `get_thread` with `target: "permalink_url"` from previous results
- Always prefer the permalink URL from search results

### "What's happening in #channel"
→ `list_messages` with `channel: "channel-name"`, `limit: 10`

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

## Search Operators

Slack search supports these operators embedded in the `query`:
- `from:username` — messages from a person
- `to:username` — direct messages to a person
- `with:@person` — DMs and threads with a specific person
  (also available as the `with` parameter)
- `in:#channel` — messages in a channel
- `has:reaction` / `has:link` / `has:pin` — message properties
- `hasmy::emoji:` — messages you reacted to with a specific emoji
- `is:thread` — only thread messages
- `is:saved` — your saved items
- `after:YYYY-MM-DD` / `before:YYYY-MM-DD` — date range
- `on:YYYY-MM-DD` — exact date
- `during:month` / `during:year` — relative dates (e.g. `during:march`)
- `"exact phrase"` — quoted exact phrase match
- `term -excluded` — exclude results containing a word
- `rep*` — wildcard prefix match (min 3 characters)

Structured parameters (`from`, `with`, `channel`, `after`,
`before`) get appended as operators to the query string.

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

## Efficiency: Minimise Tool Calls

The Slack API has no "top DM partners" or "most active
channels" endpoint. Complex questions require creative
querying. Aim to extract maximum information from each call.

**Use `with:` for DM queries**: the `with` parameter
searches DMs and threads with a specific person in one call.
"Messages with chao.duan" → `search_messages` with
`with: "chao.duan"`. Much more efficient than searching by
channel ID.

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

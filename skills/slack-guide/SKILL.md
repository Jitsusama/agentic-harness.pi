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
→ `search_messages` with `query: "from:me to:person"` or
  `from: "my.handle"` with the other person's context

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
- `in:#channel` — messages in a channel
- `has:reaction` / `has:link` / `has:pin` — message properties
- `after:YYYY-MM-DD` / `before:YYYY-MM-DD` — date range
- `during:month` / `during:today` — relative dates

These can also be passed as structured parameters (`from`,
`channel`, `after`, `before`) which get appended to the query.

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

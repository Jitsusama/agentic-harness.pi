---
name: slack-guide
description: >
  Access Slack: search messages, read threads, send messages,
  send threads, upload files, look up users and channels,
  manage reactions. Use when asked to "check Slack", "find
  messages", "search Slack", "send a message", "post a
  thread", "send these as a thread", "upload a file",
  "share this file", "attach this", "what did X say",
  "show me the thread", "who is", "react to", or any query
  about Slack messages, channels or users.
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

## Identifier Resolution

The `channel` parameter accepts **any identifier format**
uniformly across all actions:

- Channel names: `"gitstream"` or `"#gitstream"`
- Channel IDs: `"C0AJY0FLK8Q"`
- User IDs: `"U093FQUHEJG"` (resolves to the DM conversation)
- Slack permalink URLs: passed as `target`, parsed automatically

The tool resolves all identifiers before processing. You don't
need to worry about which format a particular action expects;
use whatever you have from previous context.

**One exception**: `search_messages` and `search_files` cannot
search inside DM or group DM conversations. If you pass a user
ID or DM channel ID as `channel` to a search action, the tool
returns a clear error directing you to use `list_messages`
instead. This is a Slack API limitation, not a tool limitation.

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
  to find the DM automatically. This returns only DM messages
  — complete and in order.

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
→ `get_thread` with the message's `channel` + `ts`, or with
  `target` if you have a permalink URL from search results.
  Both approaches work identically — use whichever you have.

  Every message in tool results includes a `(ts:...)` value
  in its header line. Use that exact value. **Never fabricate
  or guess a timestamp** — Slack timestamps are precise
  identifiers, not derivable from human-readable dates.

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

### "Start a group DM with [person] and [person]"
→ `send_message` with `channel` set to comma-separated user
  IDs or @handles, and `text` for the message body.
  Examples:
  - `channel: "W018HTJBU1H,U09HTCT9YLU"`
  - `channel: "@katie.laliberte,@jonathan.feng"`

  The tool calls `conversations.open` with multiple users to
  create or find the group DM, then sends the message.
  Handles are resolved to user IDs automatically. If you
  already have user IDs from a previous `get_user` call, use
  those directly.

### "Reply to that thread saying…"
→ `reply_to_thread` with `channel`, `ts` (from previous context), and `text`

### "React to that with :emoji:"
→ `add_reaction` with `target` or `channel`+`ts`, and `emoji`

### "Send this file to #channel" / "Share this in #channel"
→ `upload_file` with `file_path` and `channel`
- The file path must be an absolute path or relative to the
  current working directory.
- Add `text` for an initial comment introducing the file.

### "Reply with this file attached" / "Share this in the thread"
→ `upload_file` with `file_path`, `channel`+`ts` (or
  `target`), and optionally `text`
- Thread targeting works the same as `reply_to_thread`:
  use `target` for a permalink or `channel`+`ts` for
  explicit targeting.

### "Send a message with this file" / "Message them with the report"
→ `send_message` with `text`, `channel`, and `file_path`
- When `file_path` or `file_paths` is present on
  `send_message` or `reply_to_thread`, the file gets
  uploaded and shared alongside the message text.
- This is the natural choice when the user wants both a
  message and a file attachment in a single action.

### "Upload these files" / "Share all of these"
→ `upload_file` with `file_paths` (array) and `channel`
- Multiple files are uploaded individually and shared
  together in a single message.
- `file_path` (singular) and `file_paths` (array) can be
  combined; duplicates are ignored.

### "Post a thread about X" / "Send these as a thread"
→ `send_thread` with `channel` and `messages` array
- The first message becomes the thread parent; the rest
  become replies in order.
- Each message object has `text` and optional `file_path`
  / `file_paths` for attachments.
- A tabbed review gate shows every message for approval
  before anything is sent. Rejecting or redirecting any
  single message halts the entire thread and nothing is
  sent.
- When the user rejects or steers a message, their note
  tells you what to change. Rewrite the affected
  message(s) based on their feedback and resubmit the
  full `messages` array. Don't drop the rejected message;
  fix it. Don't resend only the rejected one; the whole
  thread must be reviewed together.
- Every message must be reviewed. If the user submits
  early (Ctrl+Enter) without reviewing all tabs, the
  gate rejects with a note asking them to review
  everything.

```
slack({ action: "send_thread", channel: "#team-updates",
        messages: [
          { text: "Weekly update for the team" },
          { text: "Progress: shipped the new dashboard" },
          { text: "Blockers: waiting on API access" }
        ] })
```

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

All identifier formats are resolved automatically:

- **Permalink URLs**: pass as `target` — works for any
  message-targeting action (`get_message`, `get_thread`,
  `get_reactions`, `reply_to_thread`, `add_reaction`,
  `remove_reaction`).
- **Channel + ts**: pass as `channel` + `ts` — works for
  the same actions. Equivalent to using a permalink.
- **Channel names**: with or without `#`. Resolved to the
  conversation automatically.
- **User IDs as channel**: resolves to the DM conversation
  automatically via `conversations.open`.
- **Comma-separated user IDs or @handles**: resolves to a
  group DM via `conversations.open` with multiple users.
- **User handles**: with or without `@`. Resolved to user
  IDs automatically.
- **Timestamps**: the `ts` field from previous results.

## Context Management

### Remember Previous Results

After `search_messages`, remember the message list. The user
may say:
- "Show me the thread for the first one" → use the permalink
  or channel + ts from the result
- "What's the context for that third message" → get_thread
- "Reply to that" → use channel + ts from the message

After `list_messages` in a channel, the user may say:
- "What's that thread about" → get_thread with channel + ts
- "Send a reply" → reply_to_thread

After `get_user`, the user may ask:
- "Send them a message" → use the user ID as channel

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
results gives you conversation metadata, user IDs,
timestamps and text. Extract patterns from that data before
making more calls. Don't look up each user or channel
individually unless you need details beyond what the search
gave you.

**User mentions are auto-resolved**: the tool resolves raw
Slack user IDs (U08ME9KASG7) to @handles automatically,
both in message author fields and in message text mentions.
You don't need to call `get_user` just to learn someone's
name — it already appears in message output.

**Conversation types are resolved automatically**: each
message includes conversation metadata with a `displayName`
and `kind`. Kinds are `dm` (1:1 direct message), `group_dm`
(multi-person DM), or `channel` (public or private channel).
Use these to filter results instead of guessing from ID
prefixes.

**Use search operators aggressively**: combine operators to
narrow results. `from:me with:@person after:2025-03-01` is
far more efficient than broad searches filtered after the
fact.

**For "who do I DM most"**: search `from:me` with a high
limit. Each result has a conversation `kind` of `dm`,
`group_dm` or `channel`. Filter to `dm` and `group_dm`
entries and count by conversation to rank DM partners.
Display names show who the DM is with (e.g. "@chao.duan"
or "@chao.duan, @xiao.li, @henrique.andrade").

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
Deduplicate across results and filter by conversation `kind`
if the user asks about DMs specifically.

**Warn the user** that this only covers common emojis. Custom
or unusual reactions may be missed.

## Message Formatting (mrkdwn)

Slack uses its own markup format called **mrkdwn**, not
standard markdown. When composing messages, use these rules:

### Text Formatting
- **Bold**: `*text*` (single asterisks, not double)
- **Italic**: `_text_` (underscores)
- **Strikethrough**: `~text~` (single tildes)
- **Inline code**: `` `code` ``
- **Code block**: triple backticks on their own lines.
  No language hints — Slack ignores them and renders the
  hint as literal text.

### Structure
- **Bulleted lists**: start each line with `• ` (Unicode
  bullet, U+2022). mrkdwn has no list syntax — Slack's
  editor creates `rich_text_list` blocks behind the scenes,
  but the API sends plain text. `•` is the closest visual
  approximation; wrapped lines won't indent like native
  Slack lists. `-` and `*` do NOT render as bullets.
- **No ordered lists**: mrkdwn has no numbered list syntax.
  `1.` renders as literal text. Use `•` for all lists.
- **Blockquotes**: `>` at the start of the line
- **Line breaks**: newlines are preserved as-is
- **No headers**: `#` has no special meaning in Slack

### Links and Mentions
- **Links**: `<https://example.com|display text>` (not
  markdown's `[text](url)` syntax)
- **User mentions**: `<@U12345>` with the user's Slack ID
- **Channel mentions**: `<#C12345>` with the channel ID

### What Doesn't Work
- `**double asterisks**` — renders as literal asterisks
- `~~double tildes~~` — renders as literal tildes
- ` ```python ` — the language hint appears as text
- `[text](url)` — renders as literal brackets
- `# Heading` — renders as literal `#`
- `![alt](image-url)` — no image embedding
- `- item` or `* item` — not converted to bullets
- `1. item` — no ordered list rendering

## Uploading Files

The `upload_file` action uploads local files to Slack using
the V2 external upload API. Files can also be attached to
`send_message` and `reply_to_thread` by adding `file_path`
or `file_paths` to the call.

### When to Use Which

**File only (no message text):**
```
slack({ action: "upload_file", channel: "team-updates",
        file_path: "/path/to/report.pdf" })
```

**File with an introductory comment:**
```
slack({ action: "upload_file", channel: "team-updates",
        file_path: "/path/to/report.pdf",
        text: "Here's the weekly report" })
```

**Message with file attachment:**
```
slack({ action: "send_message", channel: "team-updates",
        text: "Here's the weekly report",
        file_path: "/path/to/report.pdf" })
```
The `send_message` and `reply_to_thread` approach is the
natural choice when the user's intent is "send a message
with an attachment."

**Thread reply with file:**
```
slack({ action: "reply_to_thread", channel: "C0AJY0FLK8Q",
        ts: "1743044006.509399",
        text: "Updated version attached",
        file_path: "/path/to/updated.png" })
```
Alternatively, use `upload_file` with `target` or
`channel`+`ts` for thread targeting.

**Multiple files:**
```
slack({ action: "upload_file", channel: "design-reviews",
        file_paths: ["/path/to/mockup-v1.png",
                     "/path/to/mockup-v2.png"],
        text: "Two options for the new layout" })
```
`file_path` and `file_paths` can be combined; duplicates
are ignored.

### File Path Resolution

File paths must be absolute or relative to the current
working directory. The tool reads the file from disk and
uploads the raw bytes to Slack. It supports any file type:
images, PDFs, code files, documents and anything else Slack
accepts.

**Thread messages with attachments:**
```
slack({ action: "send_thread", channel: "design-reviews",
        messages: [
          { text: "Two layout options for review" },
          { text: "Option A",
            file_path: "/path/to/mockup-v1.png" },
          { text: "Option B",
            file_path: "/path/to/mockup-v2.png" }
        ] })
```
Each message in a `send_thread` call can have its own
attachments. Files are uploaded into the thread after
each message is sent.

### Confirmation Gate

All file uploads show a confirmation gate before uploading.
The gate displays file names, sizes and the destination
channel or thread. The user can approve, reject or redirect.

`send_thread` uses a tabbed confirmation gate: one tab per
message showing the text and any attached files. All
messages must be approved before anything is sent. If the
user rejects or steers any message, the entire thread is
halted. Rewrite the affected message(s) based on the
user's feedback and resubmit the full array.

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

# ✅ Good: use the permalink or channel + ts from the result
slack({ action: "get_thread", target: "https://...permalink..." })
slack({ action: "get_thread", channel: "C0AJY0FLK8Q", ts: "1743044006.509399" })
```

**DON'T** fabricate or guess Slack timestamps:
```
# ❌ Bad: inventing a timestamp that looks plausible
slack({ action: "get_thread", channel: "C0AJY0FLK8Q", ts: "1776349731.307559" })

# ✅ Good: use the (ts:...) value from a previous result
# Result showed: **@user** Apr 16, 10:02 AM (ts:1776348171.653739) [6 replies]
slack({ action: "get_thread", channel: "C0AJY0FLK8Q", ts: "1776348171.653739" })
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

**DON'T** use `search_messages` to search DMs:
```
# ❌ Bad: search can't target DM conversations
slack({ action: "search_messages", channel: "U093FQUHEJG" })

# ✅ Good: list_messages resolves user IDs to DMs
slack({ action: "list_messages", channel: "U093FQUHEJG" })
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

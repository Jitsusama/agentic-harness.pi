---
name: google-workspace-guide
description: Access Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Slides). Use when asked to "check email", "read inbox", "get calendar", "what's on my schedule", "find in drive", "search drive", "read doc", "open spreadsheet", "show slides", "list emails", "emails from [person]", "send email", "reply to", "schedule meeting", "create event", "cancel meeting", or any query about the user's Google account data. Handles email, calendar, documents, and files.
---

# Google Workspace

Access Gmail, Google Calendar, and Google Drive through the `google` tool. Translates natural language requests into structured API calls.

When composing emails, drafts or event descriptions on behalf of the user, follow the user's writing voice and prose style guides. The text should sound like the user wrote it.

## Authentication

User must run `google-auth` once to authenticate. Credentials persist in session.

## Core Principle: Translate Intent to Actions

When the user makes a natural language request, extract the core intent and parameters, then call the appropriate action.

## Gmail - Translating User Intent

### "Check my email" / "Recent emails" / "What's in my inbox"
→ `search_emails` with `query: "in:inbox"`, `limit: 10-25`

### "Find emails from [person]"
→ `search_emails` with `query: "from:person@shopify.com"`
- If user says first name, add @shopify.com domain
- Extract email if provided explicitly

### "Find emails about [topic]"
→ `search_emails` with `query: "topic"`
- Can combine: `"from:alice subject:budget"` for "emails from Alice about budget"

### "Show me that email" / "Read the second one"
→ `get_email` with `id` from previous search results
- Remember context from previous `search_emails` response
- User may reference by position: "first", "second", "the one from Alice"

### "Show me the full conversation" / "Read the thread"
→ `get_thread` with `message_id` from current email context

### "Reply to that email and say..."
→ `send_email` with:
- `to`: extract from current email context (the sender)
- `subject`: "RE: " + original subject
- `body`: user's message text
- `reply_to`: current email ID

### "Draft an email to [person] about [topic]"
→ `create_draft` with:
- `to`: parse email address(es)
- `subject`: infer from topic or ask user
- `body`: compose based on user's description

### "Send email to [person] saying..."
→ `send_email` with:
- `to`: parse email address(es) 
- `subject`: infer or extract
- `body`: user's message

### "Delete that email" / "Archive this message"
→ `delete_email` or `archive_email` with `id` from context

### "Move to inbox" / "Unarchive that email"
→ `unarchive_email` with `id` from context

### "Mark as read/unread"
→ `mark_read` or `mark_unread` with `id` from context

### Gmail Search Operators

Build queries using these operators:
- `from:email` - sender
- `to:email` - recipient  
- `subject:text` - subject line contains
- `after:YYYY-MM-DD` / `before:YYYY-MM-DD` - date range
- `newer_than:7d` / `older_than:30d` - relative dates
- `has:attachment` - has attachments
- `is:unread` / `is:starred` - status
- Space = AND: `from:alice subject:budget`
- OR: `from:alice OR from:bob`

## Calendar - Translating User Intent

### "What's on my calendar [timeframe]"

**Today:**
→ `list_events` with `start: "today"`, `end: "today"`

**Tomorrow:**
→ `list_events` with `start: "tomorrow"`, calculate end as tomorrow EOD

**This week / next week:**
→ `list_events` with calculated start (Monday) and end (Sunday)

**Specific date:**
→ `list_events` with `start: "YYYY-MM-DD"`, `end: "YYYY-MM-DD"`

### "Do I have any meetings I haven't responded to?"
→ `list_events` for upcoming week, look for ⏳ (needsAction) in results

### "Show me details for that meeting" / "What's the third event"
→ `get_event` with `event_id` from previous list results

### "Schedule [meeting] with [people] [when]"
→ `create_event` with:
- `summary`: meeting name/purpose
- `start`/`end`: parse time expressions to ISO datetime
- `attendees`: parse email addresses
- `location`: extract if mentioned

**Time parsing:**
- "tomorrow at 2pm" → calculate ISO datetime for next day 14:00
- "next Tuesday 10am" → find next Tuesday, set to 10:00
- "March 15th at 3pm for 1 hour" → start at 15:00, end at 16:00
- Always include timezone: use user's local timezone

### "Move my [time] meeting to [new time]"
→ Two steps:
1. `list_events` to find the meeting at specified time
2. `update_event` with new `start`/`end` times

### "Cancel my meeting with [person]" / "Delete that event"
→ `delete_event` with `event_id` from context or search

### "Accept/decline that meeting invitation"
→ `respond_to_event` with `response: "accepted"` or `"declined"`

### "Add [person] to that meeting"
→ `update_event` with updated `attendees` list (append to existing)

### "What's on [person]'s calendar?" / "Show me Alice's schedule"
→ `list_events` with:
- `calendar_id`: person's email address
- `start`/`end`: time window

This shows full event details when the person has shared their calendar with
you or org-wide event visibility is enabled. If it fails with a permission
error, fall back to `check_availability` which only needs free/busy access.

### "When is [person] free?" / "Check availability for [people]"
→ `check_availability` with:
- `attendees`: email addresses to check
- `start`/`end`: time window to check

Your calendar is included automatically. The response shows each person's
busy blocks and common free slots where everyone (including you) is available.
Supports up to 49 attendees.

The time window can span multiple days (e.g. an entire week). When the user
asks to "find a time this week" or "look across next week", use a single call
with the full date range rather than one call per day.

### "Schedule a meeting with [people] when everyone is free"
→ Two steps:
1. `check_availability` to find common free slots
2. `create_event` with the chosen slot and attendees

Pick the first free slot that meets the requested duration. When scanning a
multi-day range, filter free slots to business hours and skip weekends unless
the user says otherwise. The confirmation gate on `create_event` gives the
user final say before invitations go out.

## Drive - Translating User Intent

### "Find my recent files" / "What's in my Drive?"
→ `list_files` (no params = recent files, default limit 25)

### "Find [file type] about [topic]"
→ `list_files` with:
- `query`: topic keywords
- `type`: map to "doc", "sheet", "slides", "pdf"

**File type mapping:**
- "document" / "doc" / "Google Doc" → `type: "doc"`
- "spreadsheet" / "sheet" / "Excel" → `type: "sheet"`
- "presentation" / "slides" / "PowerPoint" → `type: "slides"`
- "PDF" → `type: "pdf"`

### "Open [URL]" / "Show me that doc"
→ `get_file` with:
- `url`: if user provided Google URL
- `id`: if referencing previous search result

### "My files" / "Files I own"
→ `list_files` with `owner: "me"`

### "Files [person] shared with me"
→ `list_files` with `shared: true`, `owner: "person@shopify.com"`

### "Files modified this quarter" / "Recent docs since March"
→ `list_files` with `modified_after: "YYYY-MM-DD"` (and optionally `modified_before`). Dates are YYYY-MM-DD; the API converts to RFC 3339 internally.

### "Search our team drive for [topic]"
→ Two steps:
1. `list_shared_drives` to find team drives
2. `list_files` with `shared_drive_id` and `query`

### "Show me comments on that doc"
→ `get_file` with:
- `include_comments: true`
- `comments_filter: "unresolved"` (default to unresolved unless user says "all")

## Context Management

### Remember Previous Results

**Email context:**
After `search_emails`, remember the message list. User may say:
- "Show me the first one" → use messages[0].id
- "Open the one from Alice" → find by sender
- "Delete that" → use most recently viewed email

**Calendar context:**
After `list_events`, remember the event list. User may say:
- "Show details for the 2pm" → match by time
- "Cancel the third one" → use events[2].id
- "Accept that" → use most recently viewed event

**Drive context:**
After `list_files`, remember the file list. User may say:
- "Open the first one" → use files[0].id
- "Show comments on that spreadsheet" → use most recently viewed file

### Maintain Conversation State

Track what the user is currently working with:
- Current email being read
- Current document open  
- Current event being discussed

This enables follow-ups like:
- "Reply to it" → send_email with reply_to from current email
- "Accept it" → respond_to_event with current event
- "Show comments" → get_file with include_comments for current doc

## Date and Time Handling

### Parse Relative Dates

- "today" → current date
- "tomorrow" → current date + 1 day
- "next Monday" → find next Monday
- "this week" → Monday to Sunday of current week
- "next week" → Monday to Sunday of next week

### Convert to ISO Format

Always use ISO datetime with timezone:
- `"2026-03-10T14:00:00-05:00"` (EDT)
- `"2026-03-10T15:00:00-04:00"` (EST)

Get timezone from system or default to user's location.

### Infer Duration

If user doesn't specify end time:
- Meetings: default to 30 minutes
- "for 1 hour" → add 60 minutes to start
- "all day" → use date only (no time)

## Response Interpretation

### Email Search Results

Response includes:
- Markdown list with subjects, senders, dates
- `details.messages[]` array with full metadata
- `details.nextPageToken` if more results exist

Use message IDs for follow-up actions (get_email, delete, reply).

### Calendar Results

Response includes:
- Events grouped by date
- Status indicators: ✓ accepted, ✗ declined, ❓ tentative, ⏳ needs response
- `details.events[]` array with full metadata

Use event IDs for follow-up actions (update, delete, respond).

### Drive Results

Response includes:
- File list with icons 📝📊📽️📁
- Metadata: size, owner, modified date
- `details.files[]` array

Use file IDs or URLs for follow-up (get_file).

### Document Content

Docs/Sheets/Slides rendered as markdown:
- Docs: formatted text with headings
- Sheets: markdown tables (one per sheet)
- Slides: outline format

Comments (if requested) appear at the end with status and replies.

## Common Mistakes to Avoid

**DON'T** ask user for email addresses when replying - extract from context:
```typescript
// ❌ Bad: asking for recipient
"Who should I send this to?"

// ✅ Good: infer from context
google({
  action: "send_email",
  to: [current_email_sender],
  subject: "RE: " + current_email_subject,
  reply_to: current_email_id
})
```

**DON'T** make user specify exact ISO datetime format - parse natural language:
```typescript
// ❌ Bad: asking for ISO format
"Please provide the start time in ISO 8601 format"

// ✅ Good: parse "tomorrow at 2pm"
google({
  action: "create_event",
  start: "2026-03-10T14:00:00-05:00",  // calculated from "tomorrow at 2pm"
  end: "2026-03-10T14:30:00-05:00"     // inferred 30min duration
})
```

**DON'T** forget to use page tokens when user asks for "more results":
```typescript
// User: "show me more"
google({
  action: "search_emails",
  query: same_query_as_before,
  page_token: previous_response_details.nextPageToken
})
```

## Pagination Pattern

Default limit: 25 results. If response includes `nextPageToken`:

```typescript
// First page
const result1 = google({ action: "search_emails", query: "..." })

// If user asks for more
const result2 = google({
  action: "search_emails",
  query: same_query,
  page_token: result1.details.nextPageToken
})
```

## Multi-Account

If user has multiple Google accounts:
- Default account is used unless specified
- User can say "check my personal email" → add `account: "personal"`
- List accounts: user runs `google-auth --list`

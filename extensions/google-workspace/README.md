# Google Workspace Extension

AI-friendly access to Gmail, Calendar, Drive, Docs, Sheets, and Slides through a single `google` tool.

## Features

**Phase 1-3 Complete:**
- 📧 **Gmail** - search, read, send, reply, draft, archive, delete, mark read/unread
- 📅 **Calendar** - view, create, update, delete events, respond to invites
- 📁 **Drive** - search, list files (personal + shared drives)
- 📝 **Docs/Sheets/Slides** - read content with optional comments

## Setup

1. **Get OAuth credentials:**

Create an OAuth2 client in Google Cloud Console:
- Go to: https://console.cloud.google.com/apis/credentials
- Create OAuth client → Desktop app
- Download the JSON

2. **Configure environment variables:**

Set before starting Pi:
```bash
export GOOGLE_CLIENT_ID="your-client-id-from-json"
export GOOGLE_CLIENT_SECRET="your-client-secret-from-json"
```

Or add to your shell profile (~/.zshrc, ~/.bashrc).

3. **Authenticate:**

```
google-auth
```

This opens a browser for OAuth consent. After authorizing, credentials are stored in Pi's session state.

3. **Multi-account support:**

```
google-auth --account work
google-auth --account personal
google-auth --list
google-auth --default work
```

## Tool Usage

The LLM calls the `google` tool with structured actions. See the `google-workspace` skill for detailed usage patterns.

**Examples:**
```typescript
// Search emails
google({
  action: "search_emails",
  query: "from:alice@shopify.com subject:budget"
})

// Read specific email
google({
  action: "get_email",
  id: "message_id_from_search"
})

// View calendar
google({
  action: "list_events",
  start: "today",
  end: "tomorrow"
})
```

## Architecture

```
google-workspace/
├── index.ts (435 lines)          # Tool & command registration
├── router.ts (731 lines)         # Action routing logic
├── confirmation.ts (278 lines)   # Editable confirmation gates
├── types.ts (109 lines)          # Shared interfaces
├── auth/
│   ├── oauth.ts                  # OAuth2 flow & token refresh
│   ├── credentials.ts            # Session storage helpers
│   └── server.ts                 # Local callback HTTP server
├── apis/
│   ├── gmail.ts (499 lines)      # Gmail API client
│   ├── calendar.ts (330 lines)   # Calendar API client
│   ├── drive.ts (203 lines)      # Drive API & URL parsing
│   ├── docs.ts (159 lines)       # Docs API & comments
│   ├── sheets.ts (78 lines)      # Sheets API
│   └── slides.ts (60 lines)      # Slides API
└── renderers/
    ├── email.ts (162 lines)      # Email → markdown
    ├── calendar.ts (225 lines)   # Events → markdown
    └── drive.ts (233 lines)      # Files/docs/sheets/slides → markdown
```

**Design:**
- **index.ts** - Registration only (tool, command, auth client cache)
- **router.ts** - Routes actions to handlers, delegates to APIs
- **confirmation.ts** - Uses lib/guardian/review-loop for editable gates
- **apis/** - Pure API client logic, no UI or confirmation
- **renderers/** - Pure markdown rendering, no API calls
- **auth/** - OAuth lifecycle, credential storage, callback server

## Current Limitations

- Credentials stored in Pi session (lost on restart - re-auth needed)
- No confirmation gates yet for sensitive operations (send email, delete event)

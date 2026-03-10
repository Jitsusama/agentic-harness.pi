# Google Workspace Extension

AI-friendly access to Gmail, Calendar, Drive, Docs, Sheets, and Slides through a single `google` tool.

## Features

- 📧 **Gmail** - search, read, send, reply, draft, archive, delete, mark read/unread
- 📅 **Calendar** - view, create, update, delete events, respond to invites
- 📁 **Drive** - search, list files (personal + shared drives)
- 📝 **Docs/Sheets/Slides** - read content with optional comments

## Quick Start

**Just use it!** The extension will automatically guide you through setup when you first try to use Google Workspace features.

```typescript
// Try to search emails - extension detects setup needed
google({ action: "search_emails", query: "is:unread" })

// You'll be guided through:
// 1. OAuth credentials setup (one-time, ~5 minutes)
// 2. Google account authentication (device flow)
// 3. Then your request executes!
```

### Automatic Setup Flow

**First time you use the `google` tool:**

1. **OAuth Credentials Setup** (one-time)
   - Extension detects missing OAuth credentials
   - Shows step-by-step instructions for creating them in Google Cloud Console
   - You paste Client ID and Client Secret
   - Stored persistently in your Pi session

2. **Account Authentication** (per-account)
   - Extension detects you're not authenticated
   - Initiates device flow (works everywhere!)
   - Visit https://www.google.com/device
   - Enter the code shown
   - Done!

**After setup**, the tool just works - no more prompts!

### Manual Setup (Optional)

If you prefer to set things up manually:

**Option 1: Environment variables** (bypass interactive setup)
```bash
export GOOGLE_CLIENT_ID="your-id.apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="your-secret"
```

**Option 2: Run commands explicitly**
```bash
/google-setup   # Set up OAuth credentials interactively
/google-auth    # Authenticate with your Google account
```

### Device Flow Benefits

- ✅ Works in SSH/remote sessions
- ✅ Works in Docker containers
- ✅ Works behind firewalls
- ✅ Browser can be on any device (phone, tablet, different computer)
- ✅ No localhost requirements
- ✅ No port forwarding needed

### Multi-Account Support

```bash
/google-auth --account work      # Add work account
/google-auth --account personal  # Add personal account
/google-auth --list              # List accounts
/google-auth --default work      # Set default account
```

## Tool Usage

The LLM calls the `google` tool with structured actions. See the `google-workspace` skill for detailed usage patterns.

**Examples:**
```typescript
// Search emails
google({
  action: "search_emails",
  query: "from:alice@example.com subject:budget"
})

// Read specific email
google({
  action: "get_email",
  id: "message_id_from_search"
})

// Send email (with confirmation gate)
google({
  action: "send_email",
  to: ["alice@example.com"],
  subject: "Budget Review",
  body: "Hi Alice, let's review the Q4 budget..."
})

// View today's calendar
google({
  action: "list_events",
  start: "today",
  end: "tomorrow"
})

// Search Drive files
google({
  action: "list_files",
  query: "name contains 'budget' and mimeType = 'application/pdf'"
})
```

## Architecture

```
google-workspace/
├── index.ts (258 lines)          # Tool & command registration
├── router.ts (103 lines)         # Action routing to handlers
├── router/
│   ├── gmail-handlers.ts (259)   # Gmail action handlers
│   ├── calendar-handlers.ts (263)# Calendar action handlers
│   └── drive-handlers.ts (153)   # Drive action handlers
├── render-call.ts (172 lines)    # Tool call display
├── render-result.ts (304 lines)  # Tool result display
├── params.ts (54 lines)          # Type-safe param extraction
├── auth-command.ts (171 lines)   # /google-auth handler
├── confirmation.ts (278 lines)   # Editable confirmation gates
├── types.ts (109 lines)          # Shared interfaces
├── auth/
│   ├── oauth.ts                  # OAuth2 device flow & token refresh
│   └── credentials.ts            # Session storage helpers
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

**Design principles:**
- **OAuth Device Flow** - Universal authentication (SSH, remote, containers)
- **Type-safe parameters** - No unsafe casts, proper type guards
- **Separated handlers** - Gmail/Calendar/Drive handlers in separate files
- **Confirmation gates** - Uses lib/guardian/review-loop for editable prompts
- **Clean rendering** - Descriptive TUI output with compact/expanded views

## Security

- **Device Flow** - User explicitly authorizes on Google's servers
- **Local storage** - Tokens stored in Pi session (ephemeral)
- **Confirmation gates** - Sensitive operations (send email, delete event) require approval
- **Editable gates** - User can edit subject/body before sending

## Current Limitations

- Credentials stored in Pi session (lost on restart - re-auth needed)
- Requires OAuth client setup (see Option 2 above for future improvement)

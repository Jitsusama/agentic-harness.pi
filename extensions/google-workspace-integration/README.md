# Google Workspace Extension

AI-friendly access to Gmail, Calendar, Drive, Docs, Sheets
and Slides through a single `google` tool.

## Features

- 📧 **Gmail** - search, read, send, reply, draft, archive, delete,
  mark read/unread
- 📅 **Calendar** - view, create, update, delete events, respond to invites
- 📁 **Drive** - search, list files (personal + shared drives)
- 📝 **Docs/Sheets/Slides** - read content with optional comments

## Quick Start

**Just use it!** The extension automatically guides you
through setup when you first try to use Google Workspace
features.

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

The LLM calls the `google` tool with structured actions. See
the `google-workspace` skill for detailed usage patterns.

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

The extension keeps only pi's wiring. The API clients, sign-in,
renderers and types live in [`lib/google/`](../../lib/google/), as
every integration's do.

```text
google-workspace-integration/
├── index.ts              # Tool and command registration
├── router.ts             # Routes each action to its handler
├── router/
│   ├── gmail-handlers.ts
│   ├── calendar-handlers.ts
│   └── drive-handlers.ts
├── render-call.ts        # The tool call's line
├── render-result.ts      # The tool result's display
├── auth-command.ts       # /google-auth
├── confirmation.ts       # Editable confirmation gates
└── limits.ts             # How long one read may take

lib/google/
├── apis/                 # Gmail, Calendar, Drive, Docs, Sheets, Slides
├── auth/                 # Device flow, falling back to a web redirect
├── renderers/            # Email, events and files as markdown
└── types.ts              # Shared interfaces
```

**Design principles:**
- **OAuth Device Flow** - Universal authentication (SSH, remote, containers),
  with a web redirect where the credentials want one
- **Type-safe parameters** - No unsafe casts, proper type guards
- **Separated handlers** - Gmail/Calendar/Drive handlers in separate files
- **Confirmation gates** - The `google` guard's prompts, through
  lib/guardian/apply's `approvalUnder`
- **Clean rendering** - Descriptive TUI output with compact/expanded views

## Security

- **Device Flow** - User explicitly authorizes on Google's servers
- **Keyring storage** - The OAuth app, accounts and tokens live in
  the desktop's keyring: the Secret Service on Linux, the Keychain on
  macOS, read by pi's own process. That keeps them from commands an
  agent runs, which the fence keeps off the session bus; it is no
  guard against other programs you run, since the Secret Service lets
  any of them read an unlocked collection and the Keychain item
  trusts Apple's `security`, which any of them can run. A plain
  `~/.config/agentic-harness/google/credentials.json` from before
  moves in at the next session and is removed once the keyring gives
  it back; while the keyring can't be reached (missing, locked,
  denied) pi says so and keeps using the file. Removing the file
  leaves its bytes on the disk, so sign in again once after the move
  to retire the tokens it held
- **Confirmation gates** - Sensitive operations (send email, delete
  event) require approval. They are the `google` guard, which
  blocks by default, since mail and invitations reach other people.
  While you are away ([away-workflow](../away-workflow/)) they are
  held, not sent, and listed for you when you are back
- **Editable gates** - User can edit subject/body before sending

## Current Limitations

- Requires OAuth client setup (see Option 2 above for a
  future improvement)

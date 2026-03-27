# Slack Integration

AI-friendly access to Slack through a single `slack` tool.

## Features

- 🔍 **Search** — messages and files with full Slack query syntax
- 💬 **Messages** — read, send, reply to threads
- 📢 **Channels** — info, recent messages
- 👤 **Users** — profile lookup
- 😀 **Reactions** — add, remove, view

## Quick Start

**Just use it!** The extension guides you through setup
when you first try to use Slack features.

### Automatic Setup Flow

**First time you use the `slack` tool:**

1. **OAuth App Setup** (one-time, ~5 minutes)
   - Create a Slack app at https://api.slack.com/apps
   - Add redirect URL: `http://localhost:8766`
   - Add user token scopes (see below)
   - Paste Client ID and Client Secret

2. **Authentication** (per-workspace)
   - Browser opens to Slack's authorization page
   - Approve the app in your workspace
   - Done!

### Required User Token Scopes

Add these under "User Token Scopes" (not "Bot Token Scopes"):

```
search:read          channels:read        channels:history
groups:read          groups:history       im:read
im:history           mpim:read            mpim:history
chat:write           users:read           users.profile:read
reactions:read       reactions:write
```

### Manual Setup (Optional)

**Environment variables** (bypass interactive setup):
```bash
export SLACK_CLIENT_ID="your-client-id"
export SLACK_CLIENT_SECRET="your-client-secret"
```

**Commands:**
```
/slack-setup    Set up OAuth credentials interactively
/slack-auth     Authenticate with Slack workspace
/slack-reset    Clear all configuration
```

## Architecture

```
slack-integration/
├── index.ts              Tool and command registration
├── types.ts              Shared types and param helpers
├── setup-wizard.ts       Interactive OAuth app setup
├── auth-flow.ts          Authentication orchestration
├── auth-command.ts       /slack-auth command handler
├── auth/
│   ├── store.ts          File-based persistence
│   ├── credentials.ts    Token management
│   ├── oauth-app.ts      OAuth app credential storage
│   ├── oauth.ts          OAuth2 flow (scopes, URLs, exchange)
│   ├── server.ts         Local callback server
│   └── browser.ts        Cross-platform URL opener
└── api/
    └── client.ts         Slack Web API HTTP client
```

## Security

- **OAuth2 flow** — user explicitly authorizes in their browser
- **User tokens** — `xoxp-` tokens that act as the authenticated user
- **Local storage** — tokens stored at `~/.pi/agent/slack.json`
- **Confirmation gates** — write operations require approval
- **CSRF protection** — OAuth state parameter prevents forgery

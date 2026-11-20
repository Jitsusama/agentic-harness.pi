# Slack Integration

AI-friendly access to Slack through a single `slack` tool.

## Features

- 🔍 **Search**: messages and files with full Slack query syntax
- 💬 **Messages**: read, send, reply to threads
- 📢 **Channels**: info, recent messages
- 👤 **Users**: profile lookup
- 😀 **Reactions**: add, remove, view

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

The Slack client, its sign-in and its rendering live in
[`lib/slack`](../../lib/slack/); this folder is the tool built on it.

```
slack-integration/
├── index.ts              Tool and command registration, and drawing
├── router.ts             Action dispatch and the content gate
├── resolve.ts            Identifiers to conversations, messages, users
├── results.ts            The handler shape and its plain answers
├── reads.ts              Search, messages, threads, people, reactions
├── writes.ts             Send, reply, edit and react, each gated
├── thread.ts             A thread or queued replies under one gate
├── uploads.ts            Files to a conversation or thread
├── blocks.ts             Block Kit blocks for text and tables
├── confirmation.ts       The confirmation gates
├── gateway-writes.ts     The slack guard over gateway Slack writes
├── bounded.ts            Bounding a long answer, the rest stored
├── context.ts            Who the model is on Slack
├── state.ts              The signed-in user, kept across sessions
└── auth-command.ts       /slack-auth command handler
```

## Security

- **OAuth2 flow**: user explicitly authorizes in their browser
- **User tokens**: `xoxp-` tokens that act as the authenticated user
- **Keyring storage**: the token and OAuth app live in the
  desktop's keyring, the Secret Service on Linux and the Keychain on
  macOS, read by pi's own process. That keeps them from commands an
  agent runs, which the fence keeps off the session bus; it is no
  guard against other programs you run, since the Secret Service lets
  any of them read an unlocked collection and the Keychain item
  trusts Apple's `security`, which any of them can run. A plain
  `~/.config/agentic-harness/slack/credentials.json` from before
  moves in at the next session and is removed once the keyring gives
  it back; while the keyring can't be reached, pi says so and keeps
  using the file. Removing the file leaves its bytes on the disk, so
  sign in again once after the move to retire the token it held.
- **Confirmation gates**: write operations require approval.
  They are the `slack` guard, which always blocks, since a
  message reaches other people in your name the moment it lands:
  no session or config setting turns it off. While you
  are away ([away-workflow](../away-workflow/)) a send is held,
  not sent, and listed for you when you are back.
- **Tool gateway writes**: the same guard holds Slack writes made
  through the tool gateway, such as editing a canvas, however
  they're called. With no screen, or while you're away, they're
  refused; at the screen you're asked once. Reads go through,
  and so do drafts, since you send a draft yourself. A gateway
  Slack tool not known to read is treated as a write.
- **Gateway only**: a machine that wants the tool gateway as its
  only way to Slack places a file at
  `~/.config/agentic-harness/slack/gateway-only` (under
  `$XDG_CONFIG_HOME` when that is set, like every other path here),
  from its own configuration. While it's there, the `slack` tool and
  its sign-in commands aren't registered, and nothing in the package
  reads the stored token, signs in, takes a browser's session or calls
  Slack's API (`lib/slack/policy.ts`). A session loaded before the
  file appeared keeps the tool and the commands, but each refuses,
  saying direct Slack is off, rather than asking you to sign in. The
  token stays stored, for whatever else on the machine reads it. It's
  a rule the package keeps, not a boundary: the fence is what keeps
  agents' commands from the token. Turning direct Slack back on means
  taking the line that writes the file out of the machine's
  configuration and switching; deleting the file by hand lasts only
  until the next switch.
- **CSRF protection**: OAuth state parameter prevents forgery

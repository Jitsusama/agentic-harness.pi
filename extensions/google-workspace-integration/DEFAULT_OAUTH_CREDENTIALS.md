# Default OAuth Credentials for Google Workspace Extension

## Purpose

To provide a zero-configuration authentication experience, this extension can ship with default OAuth credentials. This follows industry best practices used by:

- GitHub CLI (`gh`)
- Heroku CLI
- Vercel CLI
- Google Cloud SDK

## Setup Instructions

### 1. Create Google Cloud Project

1. Visit https://console.cloud.google.com/
2. Create a new project: "Pi Google Workspace Extension"
3. Enable APIs:
   - Gmail API
   - Google Calendar API
   - Google Drive API
   - Google Docs API
   - Google Sheets API
   - Google Slides API

### 2. Create OAuth 2.0 Credentials

1. Go to "APIs & Services" → "Credentials"
2. Click "Create Credentials" → "OAuth client ID"
3. Application type: **"Desktop app"** or **"TVs and Limited Input devices"**
4. Name: "Pi Google Workspace Extension"
5. Copy Client ID and Client Secret

### 3. Configure OAuth Consent Screen

1. Go to "OAuth consent screen"
2. User type: **External**
3. Add scopes:
   - `.../auth/gmail.modify`
   - `.../auth/calendar`
   - `.../auth/drive.readonly`
   - `.../auth/documents.readonly`
   - `.../auth/spreadsheets.readonly`
   - `.../auth/presentations.readonly`
4. Add test users if not published

### 4. Add Credentials to Extension

Add to `index.ts`:

```typescript
// Default OAuth credentials (safe to commit - public client)
const DEFAULT_OAUTH_CONFIG = {
  clientId: "YOUR_CLIENT_ID.apps.googleusercontent.com",
  clientSecret: "YOUR_CLIENT_SECRET",
};

// Allow override via environment variables
const OAUTH_CONFIG = {
  clientId: process.env.GOOGLE_CLIENT_ID || DEFAULT_OAUTH_CONFIG.clientId,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || DEFAULT_OAUTH_CONFIG.clientSecret,
};
```

## Security Considerations

**This is safe because:**

1. Device Flow is designed for public clients (no secrets required)
2. User must explicitly authorize on Google's servers
3. Tokens are stored locally per-user
4. Client secret provides minimal protection in device flow
5. Rate limits can be increased by requesting quota

**Users can still provide their own credentials** via environment variables if they prefer.

## Rate Limits

Default quotas (per project):
- 10,000 queries per day for most APIs
- Can request increases via Google Cloud Console

If shared quota becomes an issue, we can:
1. Request quota increases (usually approved quickly)
2. Implement exponential backoff
3. Show helpful error messages suggesting custom credentials

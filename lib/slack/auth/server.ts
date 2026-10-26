/**
 * Local HTTP server for the Slack OAuth2 callback.
 */

import {
	escapeHtml,
	waitForRedirect,
} from "../../core/internal/oauth-redirect.ts";

/** Result from the local OAuth2 callback: either an auth code or an error. */
export interface OAuthCallbackResult {
	code?: string;
	state?: string;
	error?: string;
}

const PAGE_STYLES = `
body {
  font-family: system-ui, -apple-system, sans-serif;
  padding: 3rem 1rem;
  text-align: center;
  color: #1a1a1a;
  background: #fafafa;
}
@media (prefers-color-scheme: dark) {
  body { color: #e0e0e0; background: #1a1a1a; }
}`;

const SUCCESS_PAGE = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Slack Authentication Successful</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <h1>✓ Slack Authentication Successful</h1>
  <p>You can close this tab and return to Pi.</p>
  <script>setTimeout(() => window.close(), 1500)</script>
</body>
</html>`;

function errorPage(error: string): string {
	return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Slack Authentication Failed</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <h1>✕ Slack Authentication Failed</h1>
  <p>Error: ${escapeHtml(error || "Unknown error")}</p>
  <p>Please try again.</p>
</body>
</html>`;
}

/**
 * Start a local server to handle the Slack OAuth callback.
 * Resolves when the callback arrives; rejects when it times out, or with
 * an `AbortError` when `signal` fires, and frees the port either way.
 */
export async function waitForOAuthCallback(
	port: number,
	options: { signal?: AbortSignal } = {},
): Promise<OAuthCallbackResult> {
	const query = await waitForRedirect(port, {
		signal: options.signal,
		success: SUCCESS_PAGE,
		failure: errorPage,
	});
	return {
		code: query.get("code") || undefined,
		state: query.get("state") || undefined,
		error: query.get("error") || undefined,
	};
}

/**
 * Local HTTP server for OAuth2 callback handling.
 */

import * as http from "node:http";

/** Timeout before the OAuth callback server gives up (5 minutes). */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** Result from the local OAuth2 callback server: either an auth code or an error. */
export interface OAuthCallbackResult {
	code?: string;
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
  <title>Authentication Successful</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <h1>✓ Authentication Successful</h1>
  <p>You can close this tab and return to Pi.</p>
  <script>setTimeout(() => window.close(), 1500)</script>
</body>
</html>`;

function errorPage(error: string): string {
	return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Authentication Failed</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <h1>✗ Authentication Failed</h1>
  <p>Error: ${error || "Unknown error"}</p>
  <p>Please try again.</p>
</body>
</html>`;
}

/**
 * Start a local server to handle the OAuth callback.
 * Returns a promise that resolves when the callback is received.
 */
export async function waitForOAuthCallback(
	port = 8765,
): Promise<OAuthCallbackResult> {
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const url = new URL(req.url || "", `http://localhost:${port}`);
			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");

			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(code ? SUCCESS_PAGE : errorPage(error || ""));

			server.close();
			resolve({ code: code || undefined, error: error || undefined });
		});

		server.on("error", (err) => {
			reject(err);
		});

		server.listen(port, "localhost");

		setTimeout(() => {
			server.close();
			reject(new Error("OAuth callback timeout after 5 minutes"));
		}, CALLBACK_TIMEOUT_MS);
	});
}

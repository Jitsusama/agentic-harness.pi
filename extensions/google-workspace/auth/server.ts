/**
 * Local HTTP server for OAuth2 callback handling.
 */

import * as http from "node:http";

export interface OAuthCallbackResult {
	code?: string;
	error?: string;
}

/**
 * Start a local server to handle OAuth callback.
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

			// Send success page
			res.writeHead(200, { "Content-Type": "text/html" });
			if (code) {
				res.end(`
					<!DOCTYPE html>
					<html>
					<head><title>Authentication Successful</title></head>
					<body style="font-family: system-ui; padding: 2rem; text-align: center;">
						<h1>✓ Authentication Successful</h1>
						<p>You can close this window and return to Pi.</p>
					</body>
					</html>
				`);
			} else {
				res.end(`
					<!DOCTYPE html>
					<html>
					<head><title>Authentication Failed</title></head>
					<body style="font-family: system-ui; padding: 2rem; text-align: center;">
						<h1>✗ Authentication Failed</h1>
						<p>Error: ${error || "Unknown error"}</p>
						<p>Please try again.</p>
					</body>
					</html>
				`);
			}

			// Close server and resolve
			server.close();
			resolve({ code: code || undefined, error: error || undefined });
		});

		// Handle server errors
		server.on("error", (err) => {
			reject(err);
		});

		// Start listening
		server.listen(port, "localhost", () => {
			// Server ready
		});

		// Timeout after 5 minutes
		setTimeout(
			() => {
				server.close();
				reject(new Error("OAuth callback timeout after 5 minutes"));
			},
			5 * 60 * 1000,
		);
	});
}

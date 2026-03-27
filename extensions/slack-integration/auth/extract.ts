/**
 * Extract Slack credentials from a curl command or raw values.
 *
 * When users copy "Copy as cURL" from browser DevTools on any
 * Slack API request, the curl command contains both the xoxc-
 * token and xoxd- cookie. This module extracts them.
 */

/** Extracted browser session credentials. */
export interface BrowserCredentials {
	token: string;
	cookie: string;
}

/**
 * Extract xoxc- token and xoxd- cookie from a curl command string.
 *
 * Looks for token patterns in the body/headers and cookie patterns
 * in the Cookie header. Throws if either is missing.
 */
export function extractFromCurl(curlCommand: string): BrowserCredentials {
	// Find xoxc- tokens anywhere in the command.
	const tokenPattern = /\b(xoxc-[a-zA-Z0-9-]{20,})/g;
	const tokens = Array.from(curlCommand.matchAll(tokenPattern), (m) => m[1]);

	// Find xoxd- cookies (usually after d= in a Cookie header).
	const cookiePattern = /\bd=(xoxd-[^;"\s&)}']+)/g;
	const cookies = Array.from(curlCommand.matchAll(cookiePattern), (m) => m[1]);

	// Also try bare xoxd- values not preceded by d=.
	if (cookies.length === 0) {
		const barePattern = /\b(xoxd-[a-zA-Z0-9%/+=_-]{20,})/g;
		const bare = Array.from(curlCommand.matchAll(barePattern), (m) => m[1]);
		cookies.push(...bare);
	}

	if (tokens.length === 0) {
		throw new Error(
			"No Slack token (xoxc-…) found in the curl command. " +
				"Make sure you copied a request to api.slack.com or edgeapi.slack.com.",
		);
	}
	if (cookies.length === 0) {
		throw new Error(
			"No Slack cookie (xoxd-…) found in the curl command. " +
				"Make sure you copied the full curl command including headers.",
		);
	}

	return { token: tokens[0], cookie: cookies[0] };
}

/** Validate that a token looks like a Slack token. */
export function isValidToken(token: string): boolean {
	return /^xox[cpb]-/.test(token);
}

/** Validate that a cookie looks like a Slack session cookie. */
export function isValidCookie(cookie: string): boolean {
	return cookie.startsWith("xoxd-");
}

/**
 * Slack Web API HTTP client.
 *
 * Thin wrapper around fetch that handles authentication,
 * rate limiting with exponential backoff, and response
 * validation. No external dependencies.
 */

const SLACK_API_BASE = "https://slack.com/api";

/** Maximum retries on rate-limited responses. */
const MAX_RETRIES = 3;

/** Initial backoff delay in milliseconds. */
const INITIAL_BACKOFF_MS = 1000;

/** Slack API response shape. Every method returns { ok, ... }. */
export interface SlackApiResponse {
	ok: boolean;
	error?: string;
	response_metadata?: {
		next_cursor?: string;
	};
	[key: string]: unknown;
}

/** Authenticated Slack API client. */
export class SlackClient {
	constructor(private readonly token: string) {}

	/**
	 * Call a Slack Web API method.
	 *
	 * Sends a POST with form-encoded body containing the token
	 * and any additional parameters. Retries on rate limits with
	 * exponential backoff.
	 */
	async call<T = Record<string, unknown>>(
		method: string,
		params: Record<string, string | number | boolean | undefined> = {},
		signal?: AbortSignal,
	): Promise<SlackApiResponse & T> {
		const body = new URLSearchParams();
		body.set("token", this.token);
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) {
				body.set(key, String(value));
			}
		}

		let lastError: Error | null = null;

		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			if (signal?.aborted) {
				throw new Error("Request aborted");
			}

			const response = await fetch(`${SLACK_API_BASE}/${method}`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: body.toString(),
				signal,
			});

			if (response.status === 429) {
				const retryAfter = Number(response.headers.get("Retry-After") || "1");
				const backoff = Math.max(
					retryAfter * 1000,
					INITIAL_BACKOFF_MS * 2 ** attempt,
				);
				await sleep(backoff);
				continue;
			}

			if (!response.ok) {
				throw new Error(
					`Slack API HTTP ${response.status}: ${response.statusText}`,
				);
			}

			const data = (await response.json()) as SlackApiResponse & T;

			if (!data.ok) {
				if (data.error === "ratelimited") {
					const backoff = INITIAL_BACKOFF_MS * 2 ** attempt;
					await sleep(backoff);
					continue;
				}
				lastError = new Error(describeError(data.error));
				throw lastError;
			}

			return data;
		}

		throw lastError ?? new Error("Slack API call failed after retries");
	}

	/**
	 * Paginate through a cursor-based Slack API method.
	 *
	 * Calls the method repeatedly, following next_cursor until
	 * all pages are collected or the limit is reached.
	 */
	async paginate<TItem>(
		method: string,
		params: Record<string, string | number | boolean | undefined>,
		extract: (response: SlackApiResponse) => TItem[],
		limit?: number,
		signal?: AbortSignal,
	): Promise<TItem[]> {
		const results: TItem[] = [];
		let cursor: string | undefined;

		do {
			const response = await this.call(method, { ...params, cursor }, signal);
			const items = extract(response);
			results.push(...items);

			cursor = response.response_metadata?.next_cursor || undefined;

			if (limit && results.length >= limit) {
				return results.slice(0, limit);
			}
		} while (cursor);

		return results;
	}
}

/** Describe a Slack API error with actionable guidance. */
function describeError(error?: string): string {
	if (!error) return "Unknown Slack API error";

	const hints: Record<string, string> = {
		invalid_auth:
			"Invalid credentials. Your token may have been revoked.\n" +
			"Run /slack-auth to re-authenticate.",
		token_revoked:
			"Token has been revoked.\n" + "Run /slack-auth to get a new token.",
		not_authed:
			"No authentication provided.\n" + "Run /slack-auth to authenticate.",
		account_inactive:
			"This Slack account has been deactivated or the workspace was deleted.",
		missing_scope:
			"Token lacks the required API scope for this operation.\n" +
			"Run /slack-auth to re-authenticate with the correct scopes.",
		channel_not_found: "Channel not found. Check the channel name or ID.",
		user_not_found: "User not found. Check the username or ID.",
	};

	const hint = hints[error];
	return hint
		? `Slack API error: ${error}\n${hint}`
		: `Slack API error: ${error}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

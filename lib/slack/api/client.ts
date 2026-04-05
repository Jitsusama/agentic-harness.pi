/**
 * Slack Web API HTTP client.
 *
 * Thin wrapper around fetch that handles authentication,
 * rate limiting with exponential backoff, and response
 * validation. No external dependencies.
 */

const SLACK_API_BASE = "https://slack.com/api";

/**
 * Maximum retries for non-rate-limit errors (network
 * failures, unexpected HTTP status codes).
 */
const MAX_ERROR_RETRIES = 3;

/**
 * Maximum rate limit retries before giving up. Rate limits
 * are transient by definition (the API tells us to wait and
 * retry), so this budget is much higher than error retries.
 */
const MAX_RATE_LIMIT_RETRIES = 10;

/** Initial backoff delay in milliseconds. */
const INITIAL_BACKOFF_MS = 1000;

/**
 * Thrown when a Slack API call exhausts its rate limit retry
 * budget. Callers can catch this specifically to implement
 * backpressure (e.g. reducing concurrency) before retrying.
 */
export class RateLimitError extends Error {
	constructor(
		/** The Slack API method that was rate limited. */
		public readonly method: string,
		/** How many rate limit responses were received. */
		public readonly hitCount: number,
	) {
		super(`Slack API rate limited ${hitCount} times for ${method}`);
		this.name = "RateLimitError";
	}
}

/**
 * Thrown when Slack returns `{ ok: false, error: "..." }`.
 *
 * Preserves the API error code so callers can distinguish
 * permanent failures (channel_not_found, not_in_channel)
 * from transient ones without parsing error message strings.
 */
export class SlackApiError extends Error {
	constructor(
		/** The Slack API error code (e.g. "not_in_channel"). */
		public readonly errorCode: string,
		message: string,
	) {
		super(message);
		this.name = "SlackApiError";
	}
}

/** Slack API response shape. Every method returns { ok, ... }. */
export interface SlackApiResponse {
	ok: boolean;
	error?: string;
	response_metadata?: {
		next_cursor?: string;
	};
	[key: string]: unknown;
}

/**
 * Authenticated Slack API client.
 *
 * Supports two auth modes:
 *   - OAuth user tokens (xoxp-): token sent in body, no cookie
 *   - Browser session tokens (xoxc-): token in body + cookie in header
 */
export class SlackClient {
	constructor(
		private readonly token: string,
		private readonly cookie?: string,
	) {}

	/**
	 * Call a Slack Web API method.
	 *
	 * Sends a POST with form-encoded body containing the token
	 * and any additional parameters. For browser session tokens,
	 * includes the session cookie in the request header. Retries
	 * on rate limits with exponential backoff.
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

		const headers: Record<string, string> = {
			"Content-Type": "application/x-www-form-urlencoded",
		};
		if (this.cookie) {
			headers.Cookie = `d=${this.cookie}`;
		}

		let lastError: Error | null = null;
		let rateLimitHits = 0;

		for (let attempt = 0; attempt < MAX_ERROR_RETRIES; attempt++) {
			if (signal?.aborted) {
				throw new Error("Request aborted");
			}

			const response = await fetch(`${SLACK_API_BASE}/${method}`, {
				method: "POST",
				headers,
				body: body.toString(),
				signal,
			});

			if (response.status === 429) {
				if (++rateLimitHits > MAX_RATE_LIMIT_RETRIES) {
					throw new RateLimitError(method, rateLimitHits);
				}
				const retryAfter = Number(response.headers.get("Retry-After") || "1");
				await sleep(retryAfter * 1000);
				// Don't count rate limits against the error retry
				// budget — the API is explicitly telling us to wait.
				attempt--;
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
					if (++rateLimitHits > MAX_RATE_LIMIT_RETRIES) {
						throw new RateLimitError(method, rateLimitHits);
					}
					const backoff = INITIAL_BACKOFF_MS * 2 ** rateLimitHits;
					await sleep(backoff);
					attempt--;
					continue;
				}
				lastError = new SlackApiError(
					data.error ?? "unknown",
					describeError(data.error),
				);
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

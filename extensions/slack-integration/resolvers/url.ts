/**
 * Parse Slack permalink URLs into channel ID and message timestamp.
 *
 * Accepts URLs like:
 *   https://myteam.slack.com/archives/C0ACMKCS6UW/p1772132415861669
 *   https://myteam.enterprise.slack.com/archives/C0ACMKCS6UW/p1772132415861669
 */

/** Parsed result from a Slack permalink URL. */
export interface ParsedSlackUrl {
	channel: string;
	ts: string;
}

/**
 * Extract channel ID and timestamp from a Slack message permalink.
 *
 * The timestamp in URLs has no dot: p1772132415861669 means
 * 1772132415.861669 in the API. We insert the dot after the
 * first 10 digits.
 */
export function parseSlackUrl(url: string): ParsedSlackUrl | null {
	const match = url.match(/archives\/([A-Z0-9]+)\/p(\d+)/);
	if (!match) return null;

	const rawTs = match[2];
	const ts = `${rawTs.slice(0, 10)}.${rawTs.slice(10)}`;
	return { channel: match[1], ts };
}

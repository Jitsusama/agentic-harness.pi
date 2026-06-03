/**
 * Built-in handle types: slack, github and email.
 *
 *     type     accepts                    canonical value
 *     ------   ------------------------   ----------------------------
 *     slack    "@joel.gerber", "joel"     lowercase, no @ prefix
 *     github   "@Jitsusama", "Jitsusama"  preserved case (GitHub usernames are case-preserving)
 *     email    "Joel@Shopify.com"         lowercase
 *
 * Slack accepts both the human handle (joel.gerber) and the
 * stable user ID (U08ME9KASG7). Both are valid canonical
 * values; the library does not try to resolve between them.
 * Callers that need to dereference one to the other do that
 * through the slack integration.
 *
 * Email parsing accepts the bare local-part-only form
 * (`joel`) only when paired with `@<domain>`. Bare local
 * parts without an `@` do not parse, because we can't tell
 * an email from a slack handle without one.
 */

import type { HandleType } from "../../people/types.js";

const SLACK_USER_ID_REGEX = /^U[A-Z0-9]{7,12}$/;
const SLACK_HANDLE_REGEX = /^[a-z0-9._-]+$/;

const slack: HandleType = {
	type: "slack",
	parse(text) {
		const trimmed = text.trim().replace(/^@/, "");
		if (SLACK_USER_ID_REGEX.test(trimmed)) return trimmed;
		const lower = trimmed.toLowerCase();
		if (SLACK_HANDLE_REGEX.test(lower) && lower.length > 0) return lower;
		return undefined;
	},
	matchAll(text) {
		const results: string[] = [];
		const seen = new Set<string>();
		// User IDs in raw form
		for (const m of text.matchAll(/\b(U[A-Z0-9]{7,12})\b/g)) {
			if (!seen.has(m[1])) {
				seen.add(m[1]);
				results.push(m[1]);
			}
		}
		// @handles in prose
		for (const m of text.matchAll(/@([a-z0-9._-]+)\b/g)) {
			const value = m[1].toLowerCase();
			if (!seen.has(value)) {
				seen.add(value);
				results.push(value);
			}
		}
		return results;
	},
};

const GITHUB_HANDLE_REGEX = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

const github: HandleType = {
	type: "github",
	parse(text) {
		const trimmed = text.trim().replace(/^@/, "");
		if (GITHUB_HANDLE_REGEX.test(trimmed)) return trimmed;
		return undefined;
	},
	matchAll(text) {
		const results: string[] = [];
		const seen = new Set<string>();
		// Match URLs that point at a user profile, not at a
		// repo. A trailing slash with another path segment
		// (`/shop/world`) means repo; we exclude it via the
		// negative lookahead. A trailing `/` alone, query
		// string or end-of-token all denote a profile URL.
		for (const m of text.matchAll(
			/https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})(?![A-Za-z0-9-])(?!\/[A-Za-z0-9])/g,
		)) {
			if (!seen.has(m[1])) {
				seen.add(m[1]);
				results.push(m[1]);
			}
		}
		return results;
	},
	url(value) {
		if (!GITHUB_HANDLE_REGEX.test(value)) return undefined;
		return `https://github.com/${value}`;
	},
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const email: HandleType = {
	type: "email",
	parse(text) {
		const trimmed = text.trim().toLowerCase();
		if (EMAIL_REGEX.test(trimmed)) return trimmed;
		return undefined;
	},
	matchAll(text) {
		const results: string[] = [];
		const seen = new Set<string>();
		for (const m of text.matchAll(
			/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
		)) {
			const lower = m[0].toLowerCase();
			if (!seen.has(lower)) {
				seen.add(lower);
				results.push(lower);
			}
		}
		return results;
	},
	url(value) {
		if (!EMAIL_REGEX.test(value)) return undefined;
		return `mailto:${value}`;
	},
};

/** All built-in handle types in stable iteration order. */
export const BUILTIN_HANDLE_TYPES: readonly HandleType[] = [
	slack,
	github,
	email,
];

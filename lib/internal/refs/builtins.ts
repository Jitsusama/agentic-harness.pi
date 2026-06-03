/**
 * Built-in ref types: GitHub issues, GitHub PRs, GitHub
 * repos, Slack messages and Slack threads.
 *
 * Each type recognises its own surface forms in text and
 * builds a canonical URL from a stored value. The canonical
 * value is the smallest unambiguous string that lets us
 * rebuild a URL without losing information.
 *
 *     type             canonical value           url shape
 *     -------------    -----------------------   ----------------------------------
 *     github-issue     owner/repo#NNN            github.com/owner/repo/issues/NNN
 *     github-pr        owner/repo#NNN            github.com/owner/repo/pull/NNN
 *     github-repo      owner/repo                github.com/owner/repo
 *     slack-message    workspace/CHANNEL/pTS     <workspace>.slack.com/archives/CHANNEL/pTS
 *     slack-thread     workspace/CHANNEL/pTS     <workspace>.slack.com/archives/CHANNEL/pTS
 *
 * GitHub's numbering shares one namespace between issues
 * and PRs within a repo, so the bare `owner/repo#NNN`
 * notation cannot distinguish them. We match the bare form
 * as `github-issue` only; PRs require a `/pull/` URL form
 * to disambiguate. The quest tool resolves the actual kind
 * via GitHub API when it matters.
 *
 * Slack threads and messages share their URL surface; we
 * discriminate by the `thread_ts` query parameter. A URL
 * with `thread_ts=` is a `slack-thread` pointing at the
 * thread parent; a URL without is a `slack-message`.
 */

import type { RefType } from "../../refs/types.js";

const GITHUB_URL_BASE = "https://github.com";

const githubIssue: RefType = {
	type: "github-issue",
	matchAll(text) {
		const results: string[] = [];
		const seen = new Set<string>();
		const push = (value: string) => {
			if (seen.has(value)) return;
			seen.add(value);
			results.push(value);
		};

		// URLs: https://github.com/owner/repo/issues/NNN
		const urlRegex =
			/https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/g;
		for (const m of text.matchAll(urlRegex)) {
			push(`${m[1]}/${m[2]}#${m[3]}`);
		}

		// Bare form: owner/repo#NNN. Constrain owner and repo
		// to look like GitHub identifiers and require word
		// boundaries so we don't match inside URLs we just
		// captured above.
		const bareRegex = /(?<![\w/])([\w.-]+)\/([\w.-]+)#(\d+)\b/g;
		for (const m of text.matchAll(bareRegex)) {
			push(`${m[1]}/${m[2]}#${m[3]}`);
		}

		return results;
	},
	url(value) {
		const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(value);
		if (!m) return undefined;
		return `${GITHUB_URL_BASE}/${m[1]}/${m[2]}/issues/${m[3]}`;
	},
};

const githubPr: RefType = {
	type: "github-pr",
	matchAll(text) {
		const results: string[] = [];
		const urlRegex =
			/https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
		for (const m of text.matchAll(urlRegex)) {
			results.push(`${m[1]}/${m[2]}#${m[3]}`);
		}
		return results;
	},
	url(value) {
		const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(value);
		if (!m) return undefined;
		return `${GITHUB_URL_BASE}/${m[1]}/${m[2]}/pull/${m[3]}`;
	},
};

const githubRepo: RefType = {
	type: "github-repo",
	matchAll(text) {
		// Match https://github.com/owner/repo with no further
		// path component. The lookahead allows whitespace,
		// end-of-input, markdown link-closing characters or a
		// trailing slash with the same suffix.
		const regex =
			/https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/?(?=$|\s|[)\].,;])/g;
		const results: string[] = [];
		for (const m of text.matchAll(regex)) {
			results.push(`${m[1]}/${m[2]}`);
		}
		return results;
	},
	url(value) {
		const m = /^([\w.-]+)\/([\w.-]+)$/.exec(value);
		if (!m) return undefined;
		return `${GITHUB_URL_BASE}/${m[1]}/${m[2]}`;
	},
};

const SLACK_URL_REGEX =
	/https:\/\/([\w-]+)\.slack\.com\/archives\/([A-Z0-9]+)\/(p\d+)(\?[^\s"')\]]*)?/g;

const slackMessage: RefType = {
	type: "slack-message",
	matchAll(text) {
		const results: string[] = [];
		for (const m of text.matchAll(SLACK_URL_REGEX)) {
			const query = m[4] ?? "";
			if (query.includes("thread_ts=")) continue;
			results.push(`${m[1]}/${m[2]}/${m[3]}`);
		}
		return results;
	},
	url(value) {
		const m = /^([\w-]+)\/([A-Z0-9]+)\/(p\d+)$/.exec(value);
		if (!m) return undefined;
		return `https://${m[1]}.slack.com/archives/${m[2]}/${m[3]}`;
	},
};

const slackThread: RefType = {
	type: "slack-thread",
	matchAll(text) {
		const results: string[] = [];
		for (const m of text.matchAll(SLACK_URL_REGEX)) {
			const query = m[4] ?? "";
			const threadTsMatch = /thread_ts=([\d.]+)/.exec(query);
			if (!threadTsMatch) continue;
			// Canonical value points at the THREAD PARENT
			// (whose ts is `thread_ts`), not the reply we
			// matched. Convert "1778683833.000200" to
			// "p1778683833000200" to match Slack's URL form
			// for the parent message.
			const parentTs = `p${threadTsMatch[1].replace(".", "")}`;
			results.push(`${m[1]}/${m[2]}/${parentTs}`);
		}
		return results;
	},
	url(value) {
		const m = /^([\w-]+)\/([A-Z0-9]+)\/(p\d+)$/.exec(value);
		if (!m) return undefined;
		return `https://${m[1]}.slack.com/archives/${m[2]}/${m[3]}`;
	},
};

/** All built-in ref types in stable iteration order. */
export const BUILTIN_REF_TYPES: readonly RefType[] = [
	githubIssue,
	githubPr,
	githubRepo,
	slackMessage,
	slackThread,
];

/**
 * URL fetchers for the `quest create --url=...` path.
 *
 * A fetcher takes a parsed ref (type + value) and returns
 * a `SeedHints` payload the create action uses to fill in
 * the new quest's title, originator and first Journey
 * entry. Fetchers are pluggable: built-ins handle
 * `github-issue` and `github-pr` via the `gh` CLI; new
 * fetchers (Slack, internal trackers, etc.) plug in through
 * `registerUrlFetcher`.
 *
 * Fetchers must be non-interactive. They never open OAuth
 * flows or write to disk. When an integration is not
 * available, return `undefined`. They are also bounded: quest
 * takes its calls one at a time, so a fetch that hangs holds every
 * later quest call behind it. A fetcher stops when the options it is
 * handed say to, by signal or by clock.
 */

import type { Ref } from "../../refs/index.ts";
import { execUnattended } from "../unattended-exec.ts";
import {
	sanitizeExcerpt,
	sanitizeHandle,
	sanitizeSingleLine,
} from "./sanitize.ts";

/**
 * How long a URL fetch may take when its caller names no clock.
 *
 * Seeding is a convenience: the quest is created without the hints
 * when they do not arrive, so this is short. A gh answering from its
 * cache takes well under a second and a cold one a few.
 */
export const URL_FETCH_TIMEOUT_MS = 20_000;

/** How a fetch may be stopped. */
export interface UrlFetchOptions {
	/** The caller giving up; the fetch ends and seeds nothing. */
	readonly signal?: AbortSignal;
	/** The longest the fetch may take. Defaults to URL_FETCH_TIMEOUT_MS. */
	readonly timeoutMs?: number;
}

/** Hints a fetcher returns to seed the new quest. */
export interface SeedHints {
	/** Suggested H1 title. */
	title?: string;
	/** Body or excerpt of the source, for the first Journey entry. */
	excerpt?: string;
	/** Source author's handle, as `type:value` (e.g. `github:octocat`). */
	originator?: { type: string; value: string };
}

export interface UrlFetcher {
	/** Ref type this fetcher handles. */
	type: string;
	/** Fetch hints for one ref of this type, stopping when told to. */
	fetch(ref: Ref, options?: UrlFetchOptions): Promise<SeedHints | undefined>;
}

import { createGlobalSymbolRegistry } from "../registry/global-symbol-registry.ts";

const registry = createGlobalSymbolRegistry<UrlFetcher>({
	slot: "pi:agentic-harness:quest-url-fetchers",
	getId: (f) => f.type,
});

/** Register a URL fetcher for a ref type. */
export const registerUrlFetcher = (fetcher: UrlFetcher): void =>
	registry.register(fetcher);

/** Remove a fetcher. Idempotent. */
export const unregisterUrlFetcher = (type: string): void =>
	registry.unregister(type);

/** Empty the registry. Tests only. */
export const clearUrlFetchers = (): void => registry.clear();

/** Look up a fetcher by ref type. */
export const getUrlFetcher = (type: string): UrlFetcher | undefined =>
	registry.get(type);

/** Snapshot of every registered fetcher. */
export const listUrlFetchers = (): UrlFetcher[] => registry.list();

/** Fetch hints for a ref, or undefined when nothing handles it. */
export async function fetchUrlHints(
	ref: Ref,
	options: UrlFetchOptions = {},
): Promise<SeedHints | undefined> {
	const fetcher = registry.get(ref.type);
	if (!fetcher) return undefined;
	try {
		return await fetcher.fetch(ref, options);
	} catch {
		// Fetcher failures are non-fatal; the caller falls back
		// to alias-only seeding.
		return undefined;
	}
}

interface GhIssueOrPrJson {
	title?: string;
	body?: string;
	author?: { login?: string };
}

async function fetchGhJson(
	subcommand: "issue" | "pr",
	value: string,
	options: UrlFetchOptions = {},
): Promise<SeedHints | undefined> {
	// Ref value is `<owner>/<repo>#<number>`. Translate to gh
	// CLI args.
	const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(value);
	if (!match) return undefined;
	const [, owner, repo, number] = match;
	// Unattended, so a gh that wants a login says so and exits rather
	// than prompting on pi's terminal, and so the clock and the signal
	// stop the process rather than only the wait on it.
	const { stdout, code } = await execUnattended(
		"gh",
		[
			subcommand,
			"view",
			number,
			"--repo",
			`${owner}/${repo}`,
			"--json",
			"title,body,author",
		],
		{
			...(options.signal ? { signal: options.signal } : {}),
			timeout: options.timeoutMs ?? URL_FETCH_TIMEOUT_MS,
		},
	);
	if (code !== 0) return undefined;
	const data = JSON.parse(stdout) as GhIssueOrPrJson;
	const hints: SeedHints = {};
	if (data.title) {
		hints.title = sanitizeSingleLine(data.title);
	}
	if (data.body) {
		hints.excerpt = sanitizeExcerpt(data.body);
	}
	if (data.author?.login) {
		const handle = sanitizeHandle(data.author.login);
		if (handle.length > 0) {
			hints.originator = { type: "github", value: handle };
		}
	}
	return Object.keys(hints).length > 0 ? hints : undefined;
}

export const githubIssueFetcher: UrlFetcher = {
	type: "github-issue",
	async fetch(ref, options) {
		return fetchGhJson("issue", ref.value, options);
	},
};

export const githubPrFetcher: UrlFetcher = {
	type: "github-pr",
	async fetch(ref, options) {
		return fetchGhJson("pr", ref.value, options);
	},
};

/** Seed the built-in fetchers. Idempotent. */
export function registerBuiltinUrlFetchers(): void {
	registerUrlFetcher(githubIssueFetcher);
	registerUrlFetcher(githubPrFetcher);
}

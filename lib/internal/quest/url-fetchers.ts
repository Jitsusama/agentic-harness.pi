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
 * available, return `undefined`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Ref } from "../../refs/index.js";
import {
	sanitizeExcerpt,
	sanitizeHandle,
	sanitizeSingleLine,
} from "./sanitize.js";

const execFileAsync = promisify(execFile);

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
	/** Fetch hints for one ref of this type. */
	fetch(ref: Ref): Promise<SeedHints | undefined>;
}

const REGISTRY_KEY = Symbol.for("pi:quest-url-fetchers");

type Registry = Map<string, UrlFetcher>;
type GlobalRegistry = Record<symbol, Registry | undefined>;

function getRegistry(): Registry {
	const slot = globalThis as GlobalRegistry;
	const existing = slot[REGISTRY_KEY];
	if (existing) return existing;
	const fresh: Registry = new Map();
	slot[REGISTRY_KEY] = fresh;
	return fresh;
}

/** Register a URL fetcher for a ref type. */
export function registerUrlFetcher(fetcher: UrlFetcher): void {
	getRegistry().set(fetcher.type, fetcher);
}

/** Remove a fetcher. Idempotent. */
export function unregisterUrlFetcher(type: string): void {
	getRegistry().delete(type);
}

/** Empty the registry. Tests only. */
export function clearUrlFetchers(): void {
	getRegistry().clear();
}

/** Look up a fetcher by ref type. */
export function getUrlFetcher(type: string): UrlFetcher | undefined {
	return getRegistry().get(type);
}

/** Snapshot of every registered fetcher. */
export function listUrlFetchers(): UrlFetcher[] {
	return [...getRegistry().values()];
}

/** Fetch hints for a ref, or undefined when nothing handles it. */
export async function fetchUrlHints(ref: Ref): Promise<SeedHints | undefined> {
	const fetcher = getRegistry().get(ref.type);
	if (!fetcher) return undefined;
	try {
		return await fetcher.fetch(ref);
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
): Promise<SeedHints | undefined> {
	// Ref value is `<owner>/<repo>#<number>`. Translate to gh
	// CLI args.
	const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(value);
	if (!match) return undefined;
	const [, owner, repo, number] = match;
	const { stdout } = await execFileAsync("gh", [
		subcommand,
		"view",
		number,
		"--repo",
		`${owner}/${repo}`,
		"--json",
		"title,body,author",
	]);
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
	async fetch(ref) {
		return fetchGhJson("issue", ref.value);
	},
};

export const githubPrFetcher: UrlFetcher = {
	type: "github-pr",
	async fetch(ref) {
		return fetchGhJson("pr", ref.value);
	},
};

/** Seed the built-in fetchers. Idempotent. */
export function registerBuiltinUrlFetchers(): void {
	registerUrlFetcher(githubIssueFetcher);
	registerUrlFetcher(githubPrFetcher);
}

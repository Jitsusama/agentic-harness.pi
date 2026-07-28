/**
 * The metadata shape this workflow's views speak, and the
 * projection onto it from what the substrate reports.
 *
 * The reads themselves live in `substrate.ts` now. What is left
 * here is the shape, the projection, and one genuinely
 * GitHub-shaped read: fetching a file's contents at a ref, which
 * the buffer viewer needs and no facet offers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Proposal } from "../../lib/review/index.js";

/** PR lifecycle states GitHub returns over GraphQL. */
export type PrState = "OPEN" | "CLOSED" | "MERGED";

/** Subset of PR metadata the workflow consumes. */
export interface PrMetadata {
	readonly title: string;
	/** Login of the author. `"ghost"` for deleted accounts. */
	readonly author: string;
	readonly state: PrState;
	readonly isDraft: boolean;
	readonly url: string;
	readonly body: string;
	readonly base: { ref: string; sha: string };
	readonly head: { ref: string; sha: string };
	readonly additions: number;
	readonly deletions: number;
	readonly changedFiles: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/**
 * Fetch a file's contents at a specific ref via `gh api`.
 *
 * Uses the contents endpoint, which returns base64-encoded
 * file data up to 1 MB. Larger files require a different
 * code path (blobs API) that lands when the workflow has a
 * reason to view them.
 */
export async function fetchFileContent(
	pi: ExtensionAPI,
	owner: string,
	repo: string,
	ref: string,
	path: string,
): Promise<string> {
	const result = await pi.exec("gh", [
		"api",
		`/repos/${owner}/${repo}/contents/${path}?ref=${ref}`,
		"--jq",
		".content",
	]);
	if (result.code !== 0) {
		throw new Error(
			`Failed to fetch ${path} at ${ref}: ${result.stderr.trim() || "non-zero exit"}`,
		);
	}
	const base64 = result.stdout.replace(/\s+/g, "");
	if (!base64) {
		throw new Error(`No content returned for ${path} at ${ref}`);
	}
	return Buffer.from(base64, "base64").toString("utf-8");
}

/**
 * A neutral proposal as the metadata this workflow's views speak.
 *
 * Every difference between the two shapes is a decision, and they
 * all fall the same way: the view has nowhere to put an absence,
 * so an absence becomes the empty value rather than the word
 * undefined on someone's screen. That is a lossy direction, which
 * is why the proposal stays the thing of record.
 *
 * The base commit is always empty. GitHub reports one, but nothing
 * in this workflow has ever read it, so the substrate was not
 * taught to carry a fact with no reader.
 */
export function metadataFromProposal(proposal: Proposal): PrMetadata {
	return {
		title: proposal.title,
		author: proposal.author.id,
		state: shoutedState(proposal.state),
		isDraft: proposal.draft,
		url: proposal.url ?? "",
		body: proposal.body,
		base: { ref: proposal.base, sha: "" },
		head: { ref: proposal.head, sha: proposal.headCommit ?? "" },
		// An unreported count has to render as something, and a change
		// nobody measured is closer to zero than to a blank.
		additions: proposal.additions ?? 0,
		deletions: proposal.deletions ?? 0,
		changedFiles: proposal.changedFiles ?? 0,
		createdAt: proposal.createdAt ?? "",
		updatedAt: proposal.updatedAt ?? "",
	};
}

/** The substrate's lower-case state in the view's own register. */
function shoutedState(state: Proposal["state"]): PrState {
	if (state === "merged") return "MERGED";
	return state === "closed" ? "CLOSED" : "OPEN";
}

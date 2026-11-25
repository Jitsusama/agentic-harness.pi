/**
 * Answering who wrote a change, for the mesh's look list. Every agent
 * opens its changes under the person's own account, so a change that
 * the account signed in to its host wrote is one his sessions put up,
 * and never goes on his look list (lib/internal/session/authored.ts).
 * Only this side knows the hosts: which one claims a URL, how to read
 * the change, and who is signed in there.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveReference } from "../../lib/core/review/index.ts";
import {
	type Authored,
	answerAuthored,
} from "../../lib/internal/session/authored.ts";
import { loadReviewConfig } from "./config.ts";
import { reviewEngine } from "./engine.ts";

/**
 * A change's own page, past any tab, file or comment of it: GitHub's
 * and Delta's `/pull/<n>/files` or `/pull/<n>.diff` are the change at
 * `/pull/<n>`, which is the shape their providers claim.
 */
const CHANGE_PAGE =
	/^(https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+)(?:[./?#].*)?$/;

/** The change's own page for `url`, past any tab, file or comment of it. */
export function changePage(url: string): string {
	return url.trim().match(CHANGE_PAGE)?.[1] ?? url.trim();
}

/** Listen for asks of who wrote a change, and answer each. Returns a disposer. */
export function answerWhoWrote(pi: ExtensionAPI): () => void {
	return answerAuthored(pi.events, (url) => whoWrote(pi, url));
}

/**
 * What the host claiming `url` says of who wrote its change, against
 * who is signed in there. Compared as the host names people (a login on
 * GitHub), in one case, since GitHub reads logins in any.
 */
export async function whoWrote(
	pi: ExtensionAPI,
	url: string,
): Promise<Authored> {
	const page = changePage(url);
	const { config } = await loadReviewConfig();
	const resolution = resolveReference(page, { config });
	if (!resolution.resolved) return { by: "no-change" };
	const conversation = resolution.provider.conversation;
	if (conversation?.viewer === undefined) {
		return {
			by: "unknown",
			why: `the ${resolution.provider.id} provider can't say who is signed in`,
		};
	}
	const { engine } = await reviewEngine(pi);
	const bound = await engine.bound(resolution.change);
	const [proposal, signedIn] = await Promise.all([
		bound.proposal(),
		conversation.viewer(resolution.change.repo),
	]);
	if (!proposal) {
		return {
			by: "unknown",
			why: `the ${resolution.provider.id} provider found no change there`,
		};
	}
	const author = proposal.author.id;
	return author.toLowerCase() === signedIn.id.toLowerCase()
		? { by: "signed-in", author }
		: { by: "other", author };
}

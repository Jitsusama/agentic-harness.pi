/**
 * Borrowing the review substrate.
 *
 * This workflow does not host the substrate; the
 * review-integration extension does. Going through the host's own
 * engine rather than building one is what makes a change from a
 * downstream provider readable here: a private engine would
 * resolve against a private registry and see only the providers
 * it registered itself.
 *
 * The handshake runs both ways because the bus does not replay. If
 * the host loaded first, its announcement is already gone by the
 * time this extension activates, so this extension asks; if the
 * host loads later, its announcement arrives on its own.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import {
	REVIEW_READY,
	REVIEW_REQUEST_SUBSTRATE,
	type ReviewSubstrateApi,
} from "../../lib/review/index.js";
import { changeFromGitHubView } from "./reference.js";
import { type ReviewThread, readConversation } from "./threads.js";

let substrate: ReviewSubstrateApi | undefined;

/** Whether a value looks like the api the host hands out. */
function isSubstrateApi(value: unknown): value is ReviewSubstrateApi {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ReviewSubstrateApi>;
	return (
		typeof candidate.engine === "function" &&
		typeof candidate.registerProvider === "function"
	);
}

/**
 * Listen for the substrate and ask for it, so this extension finds
 * the host whichever order the two of them loaded in.
 */
export function attachSubstrate(pi: ExtensionAPI): void {
	pi.events.on(REVIEW_READY, (data: unknown) => {
		if (isSubstrateApi(data)) substrate = data;
	});
	pi.events.emit(REVIEW_REQUEST_SUBSTRATE, undefined);
}

/** Hand the workflow a substrate directly. For tests. */
export function setSubstrateApi(api: ReviewSubstrateApi): void {
	substrate = api;
}

/** Drop the borrowed substrate. For tests and reloads. */
export function forgetSubstrate(): void {
	substrate = undefined;
}

/**
 * The loaded change's conversation, read through the substrate.
 *
 * Shaped to the seam the actions already inject, so the reads move
 * across without every call site learning about providers.
 */
export async function threadsFromSubstrate(
	reference: PRReference,
): Promise<ReviewThread[]> {
	if (!substrate) {
		throw new Error(
			"The review substrate never announced itself, so this pull " +
				"request's conversation cannot be read. The " +
				"review-integration extension is what provides it: check " +
				"that it is installed and enabled.",
		);
	}
	const change = changeFromGitHubView(reference);
	const engine = await substrate.engine();
	// Resolved by the name a person writes, rather than bound
	// directly, so the provider that claims it is chosen the same
	// way it would be anywhere else.
	const bound = await engine.resolve(change.label);
	if (!bound.conversation) {
		throw new Error(
			`Nothing hosts a conversation for ${change.label}, so there ` +
				"are no threads to read. A local range or an unposted " +
				"stack reviews fine but has nowhere to hold a discussion.",
		);
	}
	const target = bound.target;
	return readConversation(
		bound.conversation,
		target.kind === "proposal" ? target.change : change,
	);
}

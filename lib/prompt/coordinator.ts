/**
 * Resident system-prompt coordinator.
 *
 * A single place that assembles the resident system-prompt
 * block from its contributors in a fixed order and freezes
 * it once per session, so every turn gets byte-identical
 * output. This keeps the prompt stable across a session (no
 * churn from a contributor whose text later shifts) and gives
 * the resident block one deterministic assembly point rather
 * than several extensions each appending independently.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type SessionRef, sessionSlot } from "../core/session/index.ts";

/** A source of resident system-prompt text, ordered against its peers. */
export interface PromptContributor {
	/** Stable id; also the tie-breaker when two share an order. */
	readonly id: string;
	/** Lower numbers compose first. Conventions sit at the top. */
	readonly order: number;
	/** The text to contribute, or undefined to contribute nothing. */
	contribute(
		ctx: ExtensionContext,
	): string | undefined | Promise<string | undefined>;
}

/** A resident prompt whose bytes are fixed on first assembly. */
export interface FrozenResidentPrompt {
	/** The frozen block; identical on every call after the first. */
	assemble(ctx: ExtensionContext): Promise<string>;
}

// Shared across extension copies, but only within their conversation.
// Resolve on use: importing this module needs no ambient session.
function contributors(ref?: SessionRef): Map<string, PromptContributor> {
	return sessionSlot(
		"pi:prompt-contributors",
		ref,
		() => new Map<string, PromptContributor>(),
	);
}

/** Register or replace a contributor by id. */
export function registerPromptContributor(
	contributor: PromptContributor,
	ref?: SessionRef,
): void {
	contributors(ref).set(contributor.id, contributor);
}

/** Remove a contributor by id. Idempotent. */
export function unregisterPromptContributor(
	id: string,
	ref?: SessionRef,
): void {
	contributors(ref).delete(id);
}

/** Empty the registry. Intended for tests. */
export function clearPromptContributors(ref?: SessionRef): void {
	contributors(ref).clear();
}

/**
 * Create a resident prompt that assembles its contributors on
 * the first call and returns those exact bytes thereafter. A
 * fresh one is created per session so the freeze is
 * session-scoped; `alreadyFrozen` carries a session's freeze
 * across a reload or a resume, so it is never assembled twice.
 */
export function createFrozenResidentPrompt(
	alreadyFrozen?: string,
): FrozenResidentPrompt {
	let frozen = alreadyFrozen;
	return {
		async assemble(ctx: ExtensionContext): Promise<string> {
			if (frozen !== undefined) return frozen;
			const ranked = [...contributors(ctx).values()].sort(
				(a, b) => a.order - b.order || a.id.localeCompare(b.id),
			);
			const blocks: string[] = [];
			for (const contributor of ranked) {
				const text = await contributor.contribute(ctx);
				if (text) blocks.push(text);
			}
			frozen = blocks.join("\n\n");
			return frozen;
		},
	};
}

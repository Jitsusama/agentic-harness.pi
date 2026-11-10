/**
 * The conversation's record of its first prompt, kept apart from pi's
 * argument parser so the host's engine, which node loads without pi's
 * module aliases, can admit a conversation's first words. first-prompt.ts
 * reads the same record to say whether that prompt is still on its way.
 */

import { hosted, sessionSlot } from "../../core/session/index.ts";

/** What the conversation has seen of its first prompt, across reloads. */
export interface FirstPromptSlot {
	ran: boolean;
	hasInitialWords?: boolean;
	beganAt?: number;
}

/** The current conversation's record, made on first use. */
export function firstPromptSlot(): FirstPromptSlot {
	return sessionSlot("agentic-harness.pi/first-prompt", undefined, () => ({
		ran: false,
	}));
}

/** Admit hosted initial words once, before extension loading; no-op on pi. */
export function noteFirstPrompt(
	words: string | undefined,
	now: number = Date.now(),
): void {
	if (!hosted()) return;
	const current = firstPromptSlot();
	current.hasInitialWords = words !== undefined;
	current.beganAt = now;
	current.ran = false;
}

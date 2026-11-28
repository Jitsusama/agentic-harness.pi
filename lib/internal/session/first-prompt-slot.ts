/**
 * The conversation's record of its first prompt, kept apart from pi's
 * argument parser so the host's engine, which node loads without pi's
 * module aliases, can admit a conversation's first words and say when it
 * has handed them on. first-prompt.ts reads the same record to say
 * whether that prompt is still on its way.
 */

import { hosted, sessionSlot } from "../../core/session/index.ts";

/** What the conversation has seen of its first prompt, across reloads. */
export interface FirstPromptSlot {
	/** A run started, or the host handed its first words to pi. */
	ran: boolean;
	hasInitialWords?: boolean;
}

/** The current conversation's record, made on first use. */
export function firstPromptSlot(): FirstPromptSlot {
	return sessionSlot("agentic-harness.pi/first-prompt", undefined, () => ({
		ran: false,
	}));
}

/** Admit hosted initial words once, before extension loading; no-op on pi. */
export function noteFirstPrompt(words: string | undefined): void {
	if (!hosted()) return;
	const current = firstPromptSlot();
	current.hasInitialWords = words !== undefined;
	current.ran = false;
}

/**
 * The host has handed the conversation's first words to pi, which holds
 * them or took them as a command, so they are on their way no longer;
 * no-op on pi. Words that never become a run, as a command's don't, end
 * their wait here rather than on a clock.
 */
export function firstPromptHandedOn(): void {
	if (!hosted()) return;
	firstPromptSlot().ran = true;
}

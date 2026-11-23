/**
 * Distillation helpers for correction capture.
 *
 * Turning a session into behavioural rules has three pure parts:
 * condensing the transcript into a compact prompt, the system
 * prompt that asks a model to distill rules, and parsing the
 * model's reply back into a clean list. The live model call sits
 * between them in the extension; these parts are testable on
 * their own.
 */

import { firstJsonArray } from "../internal/json-array.ts";

/** One turn of a conversation, reduced to role and text. */
export interface Turn {
	readonly role: "user" | "assistant";
	readonly text: string;
}

/** Default cap on the condensed transcript, in characters. */
const DEFAULT_MAX_CHARS = 6000;

/** What joins one turn's line to the next. */
const TURN_GAP = "\n\n";

/**
 * Condense turns into a compact transcript string, keeping the
 * most recent turns when the whole exceeds `maxChars`. The tail
 * is what matters: corrections accumulate as the session goes on.
 *
 * Turns are read back from the newest, and the walk stops at the
 * first that no longer fits, so a long session costs only what
 * is kept. When even the newest turn alone is over the cap, its
 * last `maxChars` characters are kept.
 */
export function condenseTranscript(
	turns: readonly Turn[],
	maxChars: number = DEFAULT_MAX_CHARS,
): string {
	const kept: string[] = [];
	let length = 0;
	for (let at = turns.length - 1; at >= 0; at--) {
		const turn = turns[at];
		const text = turn?.text.trim();
		if (!turn || !text) continue;
		const line = `${turn.role === "user" ? "USER" : "ASSISTANT"}: ${text}`;
		const grown =
			length + line.length + (kept.length > 0 ? TURN_GAP.length : 0);
		if (kept.length > 0 && grown > maxChars) break;
		kept.push(line);
		length = grown;
	}
	const transcript = kept.reverse().join(TURN_GAP);
	return transcript.length > maxChars
		? transcript.slice(transcript.length - maxChars)
		: transcript;
}

/** The system prompt that asks a model to distill rules. */
export function distillSystemPrompt(): string {
	return [
		"You distill behavioural rules from a coding session.",
		"Read the transcript and find where the user corrected, steered",
		"or pushed back on the assistant. For each distinct lesson, write",
		"one short imperative rule the assistant should follow in future",
		"sessions. Rules are behavioural, not about a single task.",
		"",
		"Return only a JSON array of strings, each a single rule. No prose",
		"around it. Return an empty array when the session holds no lesson",
		"worth keeping. Aim for one to five rules; never invent a rule the",
		"transcript does not support.",
	].join("\n");
}

/** Build the user prompt for a distillation, with optional focus. */
export function distillUserPrompt(transcript: string, focus?: string): string {
	const head = focus ? `Focus on this when distilling: ${focus}\n\n` : "";
	return `${head}Transcript:\n\n${transcript}`;
}

/**
 * Parse a model reply into a clean rule list. Accepts a JSON
 * array anywhere in the reply, and falls back to markdown bullet
 * or numbered lines when the model wrapped the array in prose.
 */
export function parseRules(reply: string): string[] {
	const array = firstJsonArray(reply);
	if (array) {
		try {
			const parsed = JSON.parse(array);
			if (Array.isArray(parsed)) {
				return parsed
					.filter((r): r is string => typeof r === "string")
					.map((r) => r.trim())
					.filter((r) => r.length > 0);
			}
		} catch {
			// Not valid JSON; fall through to line parsing.
		}
	}
	return reply
		.split("\n")
		.map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim())
		.filter((line) => line.length > 0 && !line.startsWith("["));
}

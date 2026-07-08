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

import { firstJsonArray } from "../internal/json-array.js";

/** One turn of a conversation, reduced to role and text. */
export interface Turn {
	readonly role: "user" | "assistant";
	readonly text: string;
}

/** Default cap on the condensed transcript, in characters. */
const DEFAULT_MAX_CHARS = 6000;

/**
 * Condense turns into a compact transcript string, keeping the
 * most recent turns when the whole exceeds `maxChars`. The tail
 * is what matters: corrections accumulate as the session goes on.
 */
export function condenseTranscript(
	turns: Turn[],
	maxChars: number = DEFAULT_MAX_CHARS,
): string {
	const lines = turns
		.filter((t) => t.text.trim().length > 0)
		.map(
			(t) => `${t.role === "user" ? "USER" : "ASSISTANT"}: ${t.text.trim()}`,
		);
	let transcript = lines.join("\n\n");
	while (transcript.length > maxChars && lines.length > 1) {
		lines.shift();
		transcript = lines.join("\n\n");
	}
	if (transcript.length > maxChars) {
		transcript = transcript.slice(transcript.length - maxChars);
	}
	return transcript;
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

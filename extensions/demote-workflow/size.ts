/**
 * How many characters each of pi's message kinds puts into the prompt,
 * which is what the batch planner weighs a demotion against.
 *
 * Only proportions matter to the planner, since removed and re-written
 * characters scale by the same characters-per-token ratio, so these are
 * characters as sent, not tokens.
 */

import type { SizedMessage } from "../../lib/demote/index.ts";

/**
 * An image is billed by its pixels, not its payload, so its base64
 * length says nothing about its cost. A one-megapixel image, the
 * ceiling `image-budget-workflow` enforces, bills about 1,360 tokens;
 * at the 2.45 characters per token measured on the real ledger that is
 * about 3,300 characters, rounded up.
 */
export const IMAGE_CHARS = 3_500;

/** The fields a message kind might carry, read without trusting any. */
interface AnyMessage {
	readonly role: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly content?: unknown;
	readonly summary?: unknown;
	readonly command?: unknown;
	readonly output?: unknown;
	readonly excludeFromContext?: unknown;
}

function lengthOf(value: unknown): number {
	return typeof value === "string" ? value.length : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Characters one content block contributes. */
function blockChars(block: unknown): number {
	if (!isRecord(block)) return 0;
	switch (block.type) {
		case "text":
			return lengthOf(block.text);
		case "image":
			return IMAGE_CHARS;
		case "toolCall":
			return (
				lengthOf(block.name) + JSON.stringify(block.arguments ?? {}).length
			);
		default:
			// Thinking is stripped from earlier turns by the provider, and
			// anything unrecognised is safer counted as nothing than guessed.
			return 0;
	}
}

function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const block of content) total += blockChars(block);
	return total;
}

/** Size one message as the batch planner needs it. */
export function sizeOf(message: AnyMessage): SizedMessage {
	switch (message.role) {
		case "bashExecution":
			return {
				role: message.role,
				chars:
					message.excludeFromContext === true
						? 0
						: lengthOf(message.command) + lengthOf(message.output),
			};
		case "compactionSummary":
		case "branchSummary":
			return { role: message.role, chars: lengthOf(message.summary) };
		case "toolResult":
			return {
				role: message.role,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				chars: contentChars(message.content),
			};
		default:
			return { role: message.role, chars: contentChars(message.content) };
	}
}

/**
 * Reading pi's event stream: what an assistant said, and what it cost.
 *
 * One reader, for the same reason the journal has one. This was two,
 * line for line the same in two languages, because the supervisor
 * script is run directly by node and the stream reader is TypeScript.
 * They had already begun to drift, in the smallest possible way: one
 * returned `null` for a missing partial and the other `undefined`.
 *
 * The drift that matters is not that one. Everything downstream of a
 * round rests on what these functions decide, and the two callers are
 * the live path and the recovery path: a disagreement here means a
 * round read one way while it ran and another way when it was
 * collected, and there is no test that would notice, because each side
 * agrees with itself.
 *
 * Pure, taking events rather than a stream, so what it decides can be
 * tested without a process.
 */

/**
 * The assistant message an event carries, finished or not.
 *
 * A finished message arrives as `message_end`. One still being written
 * arrives as `message_update`, carrying the whole of itself so far
 * under `partial`, and a reviewer stopped at its budget never sends
 * anything else: watching only for the end throws away an answer that
 * was nearly complete.
 *
 * Reading both means the text is whatever was last seen, complete or
 * not. A partial cannot overwrite a finished answer with less, because
 * a message that has not reached its text yet carries no text to
 * overwrite it with.
 */
/** @type {typeof import("./assistant.d.mts").assistantMessage} */
export function assistantMessage(event) {
	const message =
		field(event, "type") === "message_end"
			? field(event, "message")
			: streamedPart(event);
	if (!isRecord(message)) return null;
	return message.role === "assistant" ? message : null;
}

/**
 * The session a pi process announced, off the event that announces it.
 *
 * pi writes this before its first request, even with `--no-session`,
 * and the AI proxy bills every request under the same id, so it is how
 * a run is joined to its bill exactly rather than by summing tokens.
 */
/** @type {typeof import("./assistant.d.mts").sessionOf} */
export function sessionOf(event) {
	if (field(event, "type") !== "session") return null;
	const id = field(event, "id");
	return typeof id === "string" && id !== "" ? id : null;
}

/**
 * Whether this event carries a message that is done.
 *
 * @type {typeof import("./assistant.d.mts").isFinishedMessage}
 */
export function isFinishedMessage(event) {
	return field(event, "type") === "message_end";
}

/**
 * The message so far, off an update event.
 *
 * @param {unknown} event
 * @returns {unknown}
 */
function streamedPart(event) {
	if (field(event, "type") !== "message_update") return null;
	return field(field(event, "assistantMessageEvent"), "partial") ?? null;
}

/**
 * Everything the assistant said in one message, or nothing.
 *
 * @type {typeof import("./assistant.d.mts").textOf}
 */
export function textOf(message) {
	if (!Array.isArray(message.content)) return null;
	/** @type {string[]} */
	const parts = [];
	for (const part of message.content) {
		if (
			part &&
			typeof part === "object" &&
			part.type === "text" &&
			typeof part.text === "string"
		) {
			parts.push(part.text);
		}
	}
	return parts.length === 0 ? null : parts.join("\n");
}

/**
 * What one turn cost, in both currencies.
 *
 * Every field is read under two spellings because providers disagree
 * about them, and a total is only computed when none was reported: a
 * summed fallback that overrode a real total would quietly disagree
 * with the bill.
 */
/** @type {typeof import("./assistant.d.mts").usageOf} */
export function usageOf(message) {
	const u = message.usage;
	if (!isRecord(u)) return undefined;
	const cost = isRecord(u.cost) ? u.cost : {};
	const input = number(u.input ?? u.input_tokens);
	const output = number(u.output ?? u.output_tokens);
	const cacheRead = number(u.cacheRead ?? u.cache_read_input_tokens);
	const cacheWrite = number(u.cacheWrite ?? u.cache_creation_input_tokens);
	const costInput = number(cost.input);
	const costOutput = number(cost.output);
	const costCacheRead = number(cost.cacheRead);
	const costCacheWrite = number(cost.cacheWrite);
	return {
		tokens: {
			input,
			output,
			cacheRead,
			cacheWrite,
			total: number(u.totalTokens) || input + output + cacheRead + cacheWrite,
		},
		cost: {
			input: costInput,
			output: costOutput,
			cacheRead: costCacheRead,
			cacheWrite: costCacheWrite,
			// Mirror the token total: fall back to the summed channel
			// costs when no explicit total is reported, rather than
			// dropping a turn's cost to zero.
			total:
				number(cost.total ?? u.cost_usd) ||
				costInput + costOutput + costCacheRead + costCacheWrite,
		},
	};
}

/**
 * A number, or zero, since a cost that will not read is not a cost.
 *
 * @param {unknown} value
 * @returns {number}
 */
function number(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Whether a value parsed from the stream is an object whose fields
 * can be read.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
	return typeof value === "object" && value !== null;
}

/**
 * One field of a value parsed from the stream, or nothing when the
 * value is not an object.
 *
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function field(value, key) {
	return isRecord(value) ? value[key] : undefined;
}

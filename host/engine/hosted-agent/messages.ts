/**
 * Reading pi's messages and durable's entries: what a prompt or a queued
 * word is, which result answers which call, and how a session message is
 * matched to the entry it came from.
 */
import type { EntryRecord } from "../durable-types.ts";
import type {
	AgentMessage,
	AssistantMessage,
	ContentBlock,
	ToolResultMessage,
} from "../pi-types.ts";
import { toolCalls } from "../tool-round.ts";
import { INPUT_KINDS, type InputData } from "./run.ts";

export function defaultConvertToLlm(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter((message) =>
		["system", "user", "assistant", "toolResult"].includes(message.role),
	);
}

export function normalizePromptInput(
	input: string | AgentMessage | AgentMessage[],
	images?: readonly ContentBlock[],
): AgentMessage[] {
	if (Array.isArray(input)) return input;
	if (typeof input !== "string") return [input];
	const content: ContentBlock[] = [
		{ type: "text", text: input },
		...(images ?? []),
	];
	return [{ role: "user", content, timestamp: Date.now() }];
}

/**
 * A user message's text as pi's session keys its pending list: its text
 * parts joined with nothing between, so pi finds it there and takes it off
 * as the message starts. Empty for anything else.
 */
export function queuedText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			typeof block === "object" &&
			block !== null &&
			block.type === "text" &&
			typeof block.text === "string"
				? block.text
				: "",
		)
		.join("");
}

/** What durable's own context gets for pi's input: its user content, else its text. */
export function userContent(
	messages: readonly AgentMessage[],
): string | readonly ContentBlock[] {
	const user = lastOfRole(messages, "user");
	const content = user?.content ?? messages.at(-1)?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const blocks = content.filter(
			(block): block is ContentBlock =>
				typeof block === "object" &&
				block !== null &&
				(block.type === "text" || block.type === "image"),
		);
		if (blocks.length > 0) return blocks;
	}
	return "(input)";
}

export function lastOfRole(
	messages: readonly AgentMessage[],
	role: string,
): AgentMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === role) return message;
	}
	return undefined;
}

export function inputData(entry: EntryRecord): InputData | undefined {
	if (!Object.values(INPUT_KINDS).some((kind) => kind === entry.kind))
		return undefined;
	const data = entry.data;
	if (typeof data !== "object" || data === null) return undefined;
	const { hostId, messages } = data as Partial<InputData>;
	if (typeof hostId !== "string" || !Array.isArray(messages)) return undefined;
	return { hostId, messages };
}

/**
 * What a session message and the durable entry it came from share: a
 * result's call, or another message's role and timestamp. A result is
 * not matched by its time, since pi shows the one its round made, a
 * moment before durable commits its own: on 13 November the two were
 * 1 ms apart, so a resume took the result as unshown, showed it again
 * and broke the round after it.
 */
export function messageKey(message: AgentMessage): string {
	if (typeof message.toolCallId === "string")
		return `${message.role}\u0000call\u0000${message.toolCallId}`;
	return `${message.role}\u0000${String(message.timestamp)}`;
}

/** Whether `messages` already hold a result for the call `callId`. */
export function resultShown(
	messages: readonly AgentMessage[],
	callId: string,
): boolean {
	return resultOf(messages, callId) !== undefined;
}

/** The newest result `messages` hold for the call `callId`. */
export function resultOf(
	messages: readonly AgentMessage[],
	callId: string,
): ToolResultMessage | undefined {
	const found = newest(
		messages,
		(message) => isToolResult(message) && message.toolCallId === callId,
	);
	return found && isToolResult(found) ? found : undefined;
}

/** The newest of `messages` that `matches`. */
export function newest(
	messages: readonly AgentMessage[],
	matches: (message: AgentMessage) => boolean,
): AgentMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message && matches(message)) return message;
	}
	return undefined;
}

/** The results `messages` hold for `answer`'s calls, in call order. */
export function resultsOf(
	messages: readonly AgentMessage[],
	answer: AssistantMessage,
): ToolResultMessage[] {
	return toolCalls(answer).flatMap((call) => {
		const result = resultOf(messages, call.id);
		return result ? [result] : [];
	});
}

export function isAssistant(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

export function isToolResult(message: AgentMessage): message is ToolResultMessage {
	return (
		message.role === "toolResult" && typeof message.toolCallId === "string"
	);
}

/** pi's text for a result durable wrote for a call no tool ran. */
export function unrunText(entry: EntryRecord, committed: ToolResultMessage): string {
	const data = entry.data as
		| { diagnostics?: readonly { code?: string }[] }
		| undefined;
	const codes = new Set(
		(data?.diagnostics ?? []).map((diagnostic) => diagnostic.code),
	);
	if (codes.has("tool_unavailable"))
		return `Tool ${committed.toolName} not found`;
	if (codes.has("aborted")) return "Operation aborted";
	// pi has no text of its own for this: a restart is the host's. Said plainly, as pi says its errors.
	if (codes.has("interrupted")) {
		return `Tool ${committed.toolName} was interrupted by a restart and may have partially run`;
	}
	const text = committed.content.find((block) => block.type === "text")?.text;
	return text ?? `Tool ${committed.toolName} did not run`;
}

export function jsonCopy(value: unknown): unknown {
	if (value === undefined) return undefined;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		// A value JSON cannot hold is pi's to keep; durable stores none.
		return undefined;
	}
}

/** The session's last answer when it called tools whose results the session file lacks. */
export function cutOffAnswer(
	messages: readonly AgentMessage[],
): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || message.role === "toolResult") continue;
		if (!isAssistant(message) || message.stopReason !== "toolUse")
			return undefined;
		const answered = new Set(
			messages
				.slice(index + 1)
				.flatMap((later) => (isToolResult(later) ? [later.toolCallId] : [])),
		);
		return toolCalls(message).some((call) => !answered.has(call.id))
			? message
			: undefined;
	}
	return undefined;
}

/**
 * A request's tool results put back beside their calls. Providers that
 * check message order (Anthropic's among them) refuse a request whose tool
 * result is not in the message right after its call's answer, and every
 * later request built from that transcript is refused the same way.
 *
 * pi's session writes an extension's message at once when it thinks no run
 * is under way, which puts it between a call and its result. A turn durable
 * carries on after a restart runs outside pi's own runs, so a mesh message
 * arriving mid-round did exactly that on 13 November, and two conversations
 * answered nothing but that refusal from then on. Pairing every request,
 * rather than the transcript once, also mends a conversation already held
 * in that shape on its next turn.
 */
import { isRecord } from "../../lib/internal/record.ts";
import type { AgentMessage, ToolResultMessage } from "./pi-types.ts";

/**
 * `messages` with each tool result moved up to follow its call's answer,
 * and whatever sat between them moved after the results. A result whose
 * call is not in the answer before it (a duplicate, or one whose call is
 * gone) is given as the person's text instead, saying so, since no
 * provider accepts it as a result.
 */
export function pairToolResults(
	messages: readonly AgentMessage[],
): AgentMessage[] {
	const paired: AgentMessage[] = [];
	let index = 0;
	while (index < messages.length) {
		const message = messages[index++];
		if (!message) continue;
		if (isToolResult(message)) {
			paired.push(unpairedNote(message));
			continue;
		}
		paired.push(message);
		const open = callIds(message);
		const results: AgentMessage[] = [];
		const between: AgentMessage[] = [];
		while (open.size > 0 && index < messages.length) {
			const next = messages[index];
			if (!next || next.role === "assistant") break;
			index++;
			if (isToolResult(next) && open.delete(next.toolCallId))
				results.push(next);
			else between.push(isToolResult(next) ? unpairedNote(next) : next);
		}
		paired.push(...results, ...between);
	}
	return paired;
}

function isToolResult(message: AgentMessage): message is ToolResultMessage {
	return (
		message.role === "toolResult" && typeof message.toolCallId === "string"
	);
}

/** The ids of the tool calls an answer makes; none for any other message. */
function callIds(message: AgentMessage): Set<string> {
	const ids = new Set<string>();
	const content: unknown = message.content;
	if (message.role !== "assistant" || !Array.isArray(content)) return ids;
	for (const block of content) {
		if (
			isRecord(block) &&
			block.type === "toolCall" &&
			typeof block.id === "string"
		)
			ids.add(block.id);
	}
	return ids;
}

/** A result with no call before it, as text the model can still read. */
function unpairedNote(result: ToolResultMessage): AgentMessage {
	const text = result.content
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: `A result of ${result.toolName} (call ${result.toolCallId}) whose call is not just before it, so given here as text:\n${text}`,
			},
		],
		...(result.timestamp === undefined ? {} : { timestamp: result.timestamp }),
	};
}

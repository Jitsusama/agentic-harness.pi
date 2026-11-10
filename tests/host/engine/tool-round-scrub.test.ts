/**
 * Two hosted conversations' tool rounds put a printed credential out of
 * sight in every streamed update and in the result durable commits.
 *
 * A host streams each update to whoever watches the conversation and
 * keeps the result in its durable store, so a key a command printed
 * would otherwise reach viewers and the store in full, whether or not
 * the conversation loads the secret-scrub extension.
 */
import { describe, expect, it } from "vitest";
import type {
	AgentEvent,
	AgentTool,
	AgentToolResult,
	AssistantMessage,
} from "../../../host/engine/pi-types.ts";
import { ToolRound } from "../../../host/engine/tool-round.ts";

const KEY = `AKIA${"QQQQWWWWEEEERRRR"}`;
const MARK = "[secret scrubbed: AWS access key]";

// Only argument validation is asked of pi's library by a round.
const library = {
	validateToolArguments: (_tool: AgentTool, call: { arguments: unknown }) =>
		call.arguments,
} as never;

function answer(callId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "toolCall", id: callId, name: "bash", arguments: { n: 1 } },
		],
		stopReason: "toolUse",
		api: "test",
		provider: "test",
		model: "test",
		timestamp: 0,
	};
}

/** A bash that streams what it prints, then answers with it all. */
function bash(printed: string): AgentTool {
	return {
		name: "bash",
		async execute(_id, _args, _signal, onUpdate) {
			onUpdate({ content: [{ type: "text", text: `early ${printed}` }] });
			onUpdate({
				content: [{ type: "text", text: `early ${printed}\nmore` }],
				details: { tail: printed },
			});
			return {
				content: [{ type: "text", text: `early ${printed}\nmore\ndone` }],
				details: { fullOutputPath: "/tmp/pi-bash-0.log", tail: printed },
				structuredContent: { output: printed, exitCode: 0 },
			};
		},
	};
}

/** One conversation's round, with what it showed pi and what its hook saw. */
function conversation(callId: string, printed: string) {
	const events: AgentEvent[] = [];
	const seenByHook: AgentToolResult[] = [];
	const round = new ToolRound(
		{
			library,
			hooks: {
				afterToolCall: async ({ result }) => {
					seenByHook.push(result);
					return undefined;
				},
			},
			sequential: false,
			emit: async (event) => {
				events.push(event);
			},
		},
		answer(callId),
		{ messages: [], tools: [bash(printed)] },
		undefined,
	);
	return { round, events, seenByHook, callId };
}

function shown(events: AgentEvent[], type: string): unknown[] {
	return events.flatMap((event) => {
		if (event.type !== type) return [];
		if ("partialResult" in event) return [event.partialResult];
		return "result" in event ? [event.result] : [];
	});
}

describe("a hosted tool round", () => {
	it("scrubs each conversation's streamed updates and committed result", async () => {
		const a = conversation("call-a", KEY);
		const b = conversation("call-b", `${KEY} again`);
		const [outcomeA, outcomeB] = await Promise.all([
			a.round.run(a.callId, undefined),
			b.round.run(b.callId, undefined),
		]);
		for (const { events, round, callId } of [a, b]) {
			const everything = JSON.stringify({
				updates: shown(events, "tool_execution_update"),
				end: shown(events, "tool_execution_end"),
				message: round.messages.get(callId),
			});
			expect(
				everything,
				"no update, end or message holds the key",
			).not.toContain(KEY);
			expect(shown(events, "tool_execution_update")).toHaveLength(2);
			expect(everything).toContain(MARK);
		}
		expect(outcomeA.result).toEqual({
			content: [{ type: "text", text: `early ${MARK}\nmore\ndone` }],
			details: { fullOutputPath: "/tmp/pi-bash-0.log", tail: MARK },
			structuredContent: { output: MARK, exitCode: 0 },
		});
		expect(
			JSON.stringify(outcomeB),
			"durable commits B scrubbed",
		).not.toContain(KEY);
		expect(
			JSON.stringify(a.seenByHook),
			"afterToolCall sees the raw result, as on pi",
		).toContain(KEY);
	});

	it("hands on a result with nothing to hide as the very same object", async () => {
		const quiet = conversation("call-q", "nothing secret");
		const outcome = await quiet.round.run(quiet.callId, undefined);
		expect(outcome.result).toBe(quiet.seenByHook[0]);
		expect(shown(quiet.events, "tool_execution_end")[0]).toBe(outcome.result);
	});
});

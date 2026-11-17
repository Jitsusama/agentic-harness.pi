/**
 * Hosted conversations' tool rounds put a printed credential out of sight
 * in every streamed update, in the result durable commits and in the file
 * the whole output was saved to; and a command that prints the
 * environment, read by the arguments it ran with, has every value that
 * could be a credential scrubbed, as the secret-scrub extension does.
 *
 * A host streams each update to whoever watches the conversation and
 * keeps the result in its durable store, so a key a command printed
 * would otherwise reach viewers and the store in full, whether or not
 * the conversation loads the secret-scrub extension.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

// A saved output no round can find, so the shared fixture rewrites no real file.
const NO_SUCH_FILE = "/nonexistent/pi-bash-0.log";

// Only argument validation is asked of pi's library by a round.
const library = {
	validateToolArguments: (_tool: AgentTool, call: { arguments: unknown }) =>
		call.arguments,
} as never;

function answer(
	callId: string,
	args: Record<string, unknown> = { n: 1 },
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "bash", arguments: args }],
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
				details: { fullOutputPath: NO_SUCH_FILE, tail: printed },
				structuredContent: { output: printed, exitCode: 0 },
			};
		},
	};
}

/** One conversation's round, with what it showed pi and what its hook saw. */
function conversation(
	callId: string,
	printed: string,
	args?: Record<string, unknown>,
	tool: AgentTool = bash(printed),
	change?: Partial<AgentToolResult>,
) {
	const events: AgentEvent[] = [];
	const seenByHook: AgentToolResult[] = [];
	const round = new ToolRound(
		{
			library,
			hooks: {
				afterToolCall: async ({ result }) => {
					seenByHook.push(result);
					return change;
				},
			},
			sequential: false,
			emit: async (event) => {
				events.push(event);
			},
		},
		answer(callId, args),
		{ messages: [], tools: [tool] },
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
			details: { fullOutputPath: NO_SUCH_FILE, tail: MARK },
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

	it("scrubs a printed environment's value of no known shape, with no extension loaded", async () => {
		// Made as the test runs, so no shape and no known secret holds it.
		const value = `z9${randomBytes(19).toString("hex")}`;
		const dump = conversation("call-env", `OP_SESSION_ab12=${value}`, {
			command: "printenv",
		});
		const outcome = await dump.round.run(dump.callId, undefined);
		const everything = JSON.stringify({
			updates: shown(dump.events, "tool_execution_update"),
			end: shown(dump.events, "tool_execution_end"),
			message: dump.round.messages.get(dump.callId),
			outcome,
		});
		expect(everything, "no streamed or durable record holds it").not.toContain(
			value,
		);
		expect(everything).toContain("[secret scrubbed: OP_SESSION_ab12]");
	});

	it("scrubs a streamed line setting a secret-looking value before five arrive, whatever the command", async () => {
		// A viewer on another machine sees each update, which no count waits
		// for; the settled answer is still judged by the count, as before.
		const value = `z9${randomBytes(19).toString("hex")}`;
		const printed = `loading\nPROXY_CRED=${value}\n`;
		const streamed: AgentTool = {
			name: "bash",
			async execute(_id, _args, _signal, onUpdate) {
				onUpdate({ content: [{ type: "text", text: printed }] });
				return { content: [{ type: "text", text: printed }] };
			},
		};
		const round = conversation(
			"call-partial",
			value,
			{ command: "./show-config" },
			streamed,
		);
		await round.round.run(round.callId, undefined);
		const updates = JSON.stringify(
			shown(round.events, "tool_execution_update"),
		);
		expect(updates, "no streamed update holds the value").not.toContain(
			value,
		);
		expect(updates).toContain("[secret scrubbed: PROXY_CRED]");
		// A lone line no rule knows is said as the settled answer has it, as
		// security ruled: the update scrubs it only because a dump's first
		// lines stream before there are five to count.
		expect(
			JSON.stringify({
				end: shown(round.events, "tool_execution_end"),
				message: round.round.messages.get(round.callId),
			}),
			"the settled answer is judged by the count, not as an update",
		).toContain(value);
	});

	it("hands on a streamed update with nothing to hide as the very same object", async () => {
		const update: AgentToolResult = {
			content: [{ type: "text", text: "PORT=8080\nready" }],
		};
		const quiet: AgentTool = {
			name: "bash",
			async execute(_id, _args, _signal, onUpdate) {
				onUpdate(update);
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		const round = conversation("call-quiet", "", { command: "./serve" }, quiet);
		await round.round.run(round.callId, undefined);
		expect(shown(round.events, "tool_execution_update")[0]).toBe(update);
	});

	it("says once that it withheld the streamed updates the scrub cannot read, and still settles", async () => {
		const value = `z9${randomBytes(19).toString("hex")}`;
		const details: Record<string, unknown> = {};
		details.self = details;
		const looped: AgentTool = {
			name: "bash",
			async execute(_id, _args, _signal, onUpdate) {
				const update: AgentToolResult = {
					content: [{ type: "text", text: value }],
					details,
				};
				onUpdate(update);
				onUpdate(update);
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		const round = conversation("call-loop", "", { command: "./x" }, looped);
		const outcome = await round.round.run(round.callId, undefined);
		const updates = shown(round.events, "tool_execution_update");
		expect(updates).toHaveLength(1);
		expect(JSON.stringify(updates)).toContain("withheld");
		expect(JSON.stringify(updates)).toContain("RangeError");
		expect(JSON.stringify(updates)).not.toContain(value);
		expect(outcome.result.content).toEqual([{ type: "text", text: "done" }]);
	});

	it("scrubs a printed environment's saved output file, with no extension loaded", async () => {
		const value = `z9${randomBytes(19).toString("hex")}`;
		const file = path.join(
			os.tmpdir(),
			`pi-bash-${randomBytes(8).toString("hex")}.log`,
		);
		const spilling: AgentTool = {
			name: "bash",
			async execute() {
				fs.writeFileSync(file, `OP_SESSION_ab12=${value}\nHOME=/h\n`, {
					mode: 0o600,
				});
				return {
					content: [{ type: "text", text: "HOME=/h" }],
					details: { fullOutputPath: file },
				};
			},
		};
		try {
			const dump = conversation(
				"call-spill",
				"",
				{ command: "printenv" },
				spilling,
			);
			await dump.round.run(dump.callId, undefined);
			expect(fs.readFileSync(file, "utf8")).toBe(
				"OP_SESSION_ab12=[secret scrubbed: OP_SESSION_ab12]\nHOME=/h\n",
			);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	it("scrubs the saved output a failed dump names only in its error's words, with no extension loaded", async () => {
		const value = `z9${randomBytes(19).toString("hex")}`;
		const file = path.join(
			os.tmpdir(),
			`pi-bash-${randomBytes(8).toString("hex")}.log`,
		);
		const throwing: AgentTool = {
			name: "bash",
			async execute() {
				fs.writeFileSync(file, `OP_SESSION_ab12=${value}\nHOME=/h\n`, {
					mode: 0o600,
				});
				// As pi's bash throws when a command times out or is stopped.
				throw new Error(
					`OP_SESSION_ab12=${value}\nHOME=/h\n\n[Showing lines 1-2 of 2. Full output: ${file}]\n\nCommand terminated without an exit code`,
				);
			},
		};
		try {
			const dump = conversation(
				"call-failed",
				"",
				{ command: "/usr/bin/printenv; exit 1" },
				throwing,
			);
			const outcome = await dump.round.run(dump.callId, undefined);
			expect(fs.readFileSync(file, "utf8")).toBe(
				"OP_SESSION_ab12=[secret scrubbed: OP_SESSION_ab12]\nHOME=/h\n",
			);
			expect(JSON.stringify(outcome.result)).not.toContain(value);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	it("rewrites no file a trailer names in the words of a call that didn't fail", async () => {
		const value = `z9${randomBytes(19).toString("hex")}`;
		const file = path.join(
			os.tmpdir(),
			`pi-bash-${randomBytes(8).toString("hex")}.log`,
		);
		fs.writeFileSync(file, `OP_SESSION_ab12=${value}\n`, { mode: 0o600 });
		// Output may quote a trailer, as a log of an earlier call holds one.
		const quoting: AgentTool = {
			name: "bash",
			async execute() {
				return {
					content: [
						{
							type: "text",
							text: `[Showing lines 1-1 of 1. Full output: ${file}]`,
						},
					],
					details: {},
				};
			},
		};
		try {
			const quoted = conversation(
				"call-quoting",
				"",
				{ command: "printenv" },
				quoting,
			);
			await quoted.round.run(quoted.callId, undefined);
			expect(fs.readFileSync(file, "utf8")).toContain(value);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	it("scrubs the saved output a hook's replaced details no longer name", async () => {
		const file = path.join(
			os.tmpdir(),
			`pi-bash-${randomBytes(8).toString("hex")}.log`,
		);
		const spilling: AgentTool = {
			name: "bash",
			async execute() {
				fs.writeFileSync(file, `key ${KEY}\n`, { mode: 0o600 });
				return {
					content: [{ type: "text", text: "key" }],
					details: { fullOutputPath: file },
				};
			},
		};
		try {
			const hooked = conversation(
				"call-hooked",
				"",
				{ command: "make" },
				spilling,
				{ details: { summarised: true } },
			);
			await hooked.round.run(hooked.callId, undefined);
			expect(fs.readFileSync(file, "utf8")).toBe(`key ${MARK}\n`);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	it("reads a dump by the arguments the call ran with, as its preparation left them", async () => {
		const value = `z9${randomBytes(19).toString("hex")}`;
		const prepared: AgentTool = {
			...bash(`OP_SESSION_ab12=${value}`),
			// As a tool repairs an older call's arguments into the ones it runs.
			prepareArguments: (args) => ({
				command:
					typeof args === "object" && args !== null
						? Reflect.get(args, "script")
						: undefined,
			}),
		};
		const dump = conversation(
			"call-prepared",
			"",
			{ script: "printenv" },
			prepared,
		);
		const outcome = await dump.round.run(dump.callId, undefined);
		const everything = JSON.stringify({
			updates: shown(dump.events, "tool_execution_update"),
			outcome,
		});
		expect(everything).not.toContain(value);
	});

	it("reads the same value as ordinary output when the command prints no environment", async () => {
		const value = `z9${randomBytes(19).toString("hex")}`;
		const cat = conversation("call-cat", `OP_SESSION_ab12=${value}`, {
			command: "cat notes.txt",
		});
		const outcome = await cat.round.run(cat.callId, undefined);
		expect(outcome.result).toBe(cat.seenByHook[0]);
	});

	it("hands on a result with nothing to hide as the very same object", async () => {
		const quiet = conversation("call-q", "nothing secret");
		const outcome = await quiet.round.run(quiet.callId, undefined);
		expect(outcome.result).toBe(quiet.seenByHook[0]);
		expect(shown(quiet.events, "tool_execution_end")[0]).toBe(outcome.result);
	});
});

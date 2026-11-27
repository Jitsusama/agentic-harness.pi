/**
 * The scripted model acts only on words said since its last answer. A
 * model asked again on a turn it already answered, as a carried run's
 * continue or a background command's end may ask it, would otherwise
 * read the old words once more: in h2353 on 27 November E24's host ran
 * `carry`'s bash twice, and the case killed the second command's shell
 * while the first ran on. Within a turn still running, it reads the
 * words that started it, so a second step after tool_search still works.
 */

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isRecord } from "../../../../lib/internal/record.ts";
import {
	CARRIED_FLEET,
	CARRY,
	CARRYING,
	FIFTY_ROWS,
	fauxOf,
	LONG_NAP,
	NAP,
	SCRIPTED,
	STORE,
	scriptedCore,
	WHOAMI,
} from "./scripted-model.ts";

const PACKAGE = resolve(import.meta.dirname, "../../../..");

/** A tool call the scripted model answered with. */
interface Call {
	readonly name: string;
	readonly arguments: unknown;
}

/** What the scripted model answered: how it stopped, and its calls. */
interface Answer {
	readonly stopReason: unknown;
	readonly calls: Call[];
}

/**
 * The answer the scripted model gives `messages`. An answer that isn't a
 * message, or one that stopped on an error, throws, so a broken core
 * can't pass for one that calls nothing.
 */
async function answerTo(messages: readonly object[]): Promise<Answer> {
	const core = scriptedCore(await fauxOf(PACKAGE));
	// The faux core is pi's JavaScript, which carries no types here.
	const stream = core.streamSimple(
		{ ...SCRIPTED, api: core.api } as never,
		{ messages } as never,
	);
	const message: unknown = await stream.result();
	if (
		!isRecord(message) ||
		!Array.isArray(message.content) ||
		message.stopReason === "error"
	)
		throw new Error(`not an answer: ${JSON.stringify(message)}`);
	const calls = message.content
		.filter(isRecord)
		.flatMap((part) =>
			part.type === "toolCall" && typeof part.name === "string"
				? [{ name: part.name, arguments: part.arguments }]
				: [],
		);
	return { stopReason: message.stopReason, calls };
}

/** The tool calls the scripted model answers `messages` with. */
async function callsTo(messages: readonly object[]): Promise<Call[]> {
	return (await answerTo(messages)).calls;
}

/** The names of the tools the scripted model answers `messages` with. */
async function namesTo(messages: readonly object[]): Promise<string[]> {
	return (await callsTo(messages)).map((call) => call.name);
}

const told = { role: "user", content: CARRY };
const started = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "call-1",
			name: "bash",
			arguments: { command: CARRYING, background: true },
		},
	],
};
const handedOff = {
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "bash",
	content: [{ type: "text", text: "Running as background command j1." }],
};
const answered = {
	role: "assistant",
	content: [{ type: "text", text: "sent" }],
};
const searched = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "call-2",
			name: "tool_search",
			arguments: { query: "anything" },
		},
	],
};
const found = {
	role: "toolResult",
	toolCallId: "call-2",
	toolName: "tool_search",
	content: [{ type: "text", text: "Loaded it." }],
};
// The harness says the tool list changed after tool_search, as its own.
const listed = { role: "system", content: "The tools changed." };

/** A transcript asking `words`, then searching tools, then the result. */
function afterSearch(words: string): object[] {
	return [{ role: "user", content: words }, searched, found];
}

describe("the scripted model", () => {
	it("runs the carried command when told to carry", async () => {
		expect(await callsTo([told])).toEqual([
			{ name: "bash", arguments: { command: CARRYING, background: true } },
		]);
	});

	it("runs nothing again when asked once more on a turn it answered", async () => {
		expect(await callsTo([told, started, handedOff, answered])).toEqual([]);
	});

	it("runs nothing again when a job's end comes after its answer", async () => {
		const ended = {
			role: "user",
			content: "[j1] the command exited 0 after 46 seconds.",
		};
		expect(await callsTo([told, started, handedOff, answered, ended])).toEqual(
			[],
		);
	});

	// The host cases wait on an answer that stopped, as hosted-case's
	// answeredLast reads, so a script that ended another way fails here.
	it("stops when it calls nothing", async () => {
		expect(
			(await answerTo([told, started, handedOff, answered])).stopReason,
		).toBe("stop");
	});

	// The answer the start of restart-carry's cases waits on.
	it("stops once the carried command's result is in", async () => {
		expect(await answerTo([told, started, handedOff])).toEqual({
			stopReason: "stop",
			calls: [],
		});
	});

	it("asks for a tool's result when it calls one", async () => {
		expect((await answerTo([told])).stopReason).toBe("toolUse");
	});

	it("acts on words said after its answer", async () => {
		expect(await callsTo([told, started, handedOff, answered, told])).toEqual([
			{ name: "bash", arguments: { command: CARRYING, background: true } },
		]);
	});

	describe("after a tool's result, reads the words that started the turn", () => {
		it("for store", async () => {
			expect(await callsTo(afterSearch(STORE))).toEqual([
				{ name: "spend", arguments: { query: FIFTY_ROWS, limit: 2 } },
			]);
			// More rows than the two shown, so the rest are stored under a
			// handle, which is what the host case that reads them needs.
			const rows = /json_each\('(\[[0-9,]*\])'\)/.exec(FIFTY_ROWS)?.[1];
			expect(JSON.parse(rows ?? "[]")).toHaveLength(50);
		});

		it("for end", async () => {
			expect(await callsTo(afterSearch("end ABC123"))).toEqual([
				{ name: "mesh_end", arguments: { peer: "ABC123" } },
			]);
		});

		it("for fleet, run in the foreground", async () => {
			const job = (id: string) => ({
				id,
				cwd: "/tmp/x",
				userPrompt: WHOAMI,
				extraExtensions: ["/tmp/y.ts"],
			});
			expect(await callsTo(afterSearch("fleet /tmp/x /tmp/y.ts"))).toEqual([
				{ name: "subagent", arguments: { jobs: [job("one"), job("two")] } },
			]);
		});

		it("for fleet-carry, run in the background", async () => {
			const job = (id: string, userPrompt: string) => ({
				id,
				userPrompt,
				cwd: "/tmp/x",
				extraExtensions: ["/tmp/y.ts"],
			});
			expect(
				await callsTo(afterSearch("fleet-carry /tmp/x /tmp/y.ts")),
			).toEqual([
				{
					name: "subagent",
					arguments: {
						runId: CARRIED_FLEET,
						background: true,
						jobs: [job("one", NAP), job("two", LONG_NAP)],
					},
				},
			]);
		});

		it("past the system message the harness puts after it", async () => {
			expect(await namesTo([...afterSearch(STORE), listed])).toEqual(["spend"]);
		});

		// Store is matched before end, so an earlier turn's store read back
		// would answer spend here.
		it("and not an earlier turn's", async () => {
			expect(
				await namesTo([
					{ role: "user", content: STORE },
					answered,
					...afterSearch("end ABC123"),
				]),
			).toEqual(["mesh_end"]);
		});
	});
});

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
	CARRY,
	CARRYING,
	fauxOf,
	SCRIPTED,
	STORE,
	scriptedCore,
} from "./scripted-model.ts";

const PACKAGE = resolve(import.meta.dirname, "../../../..");

/** A tool call the scripted model answered with. */
interface Call {
	readonly name: string;
	readonly arguments: unknown;
}

/** The tool calls the scripted model answers `messages` with. */
async function callsTo(messages: readonly object[]): Promise<Call[]> {
	const core = scriptedCore(await fauxOf(PACKAGE));
	// The faux core is pi's JavaScript, which carries no types here.
	const stream = core.streamSimple(
		{ ...SCRIPTED, api: core.api } as never,
		{ messages } as never,
	);
	const message: unknown = await stream.result();
	const content =
		isRecord(message) && Array.isArray(message.content) ? message.content : [];
	return content
		.filter(isRecord)
		.flatMap((part) =>
			part.type === "toolCall" && typeof part.name === "string"
				? [{ name: part.name, arguments: part.arguments }]
				: [],
		);
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

	it("acts on words said after its answer", async () => {
		expect(await namesTo([told, started, handedOff, answered, told])).toEqual([
			"bash",
		]);
	});

	describe("after a tool's result, reads the words that started the turn", () => {
		it("for store", async () => {
			expect(await namesTo(afterSearch(STORE))).toEqual(["spend"]);
		});

		it("for end", async () => {
			expect(await callsTo(afterSearch("end ABC123"))).toEqual([
				{ name: "mesh_end", arguments: { peer: "ABC123" } },
			]);
		});

		it("for fleet", async () => {
			expect(await namesTo(afterSearch("fleet /tmp/x /tmp/y.ts"))).toEqual([
				"subagent",
			]);
		});

		it("for fleet-carry", async () => {
			expect(
				await namesTo(afterSearch("fleet-carry /tmp/x /tmp/y.ts")),
			).toEqual(["subagent"]);
		});

		it("past the system message the harness puts after it", async () => {
			expect(await namesTo([...afterSearch(STORE), listed])).toEqual(["spend"]);
		});

		it("and not an earlier turn's", async () => {
			expect(
				await namesTo([
					{ role: "user", content: "end ABC123" },
					answered,
					...afterSearch(STORE),
				]),
			).toEqual(["spend"]);
		});
	});
});

/**
 * The scripted model acts only on words said since its last answer. A
 * model asked again on a turn it already answered, as a carried run's
 * continue or a background command's end may ask it, would otherwise
 * read the old words once more: in h2353 on 27 November E24's host ran
 * `carry`'s bash twice, and the case killed the second command's shell
 * while the first ran on.
 */

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CARRY,
	CARRYING,
	fauxOf,
	SCRIPTED,
	scriptedCore,
} from "./scripted-model.ts";

const PACKAGE = resolve(import.meta.dirname, "../../../..");

/** What the scripted model answers to `messages`, as its tool calls and words. */
async function answerTo(messages: readonly object[]): Promise<{
	calls: { name: string; arguments: unknown }[];
	text: string;
}> {
	const core = scriptedCore(await fauxOf(PACKAGE));
	const stream = core.streamSimple(
		{ ...SCRIPTED, api: core.api } as never,
		{ messages } as never,
	);
	const message = (await stream.result()) as {
		content: {
			type: string;
			name?: string;
			arguments?: unknown;
			text?: string;
		}[];
	};
	return {
		calls: message.content
			.filter((part) => part.type === "toolCall")
			.map((part) => ({ name: part.name ?? "", arguments: part.arguments })),
		text: message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join(""),
	};
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

describe("the scripted model", () => {
	it("runs the carried command when told to carry", async () => {
		expect((await answerTo([told])).calls).toEqual([
			{ name: "bash", arguments: { command: CARRYING, background: true } },
		]);
	});

	it("runs nothing again when asked once more on a turn it answered", async () => {
		expect(
			(await answerTo([told, started, handedOff, answered])).calls,
		).toEqual([]);
	});

	it("reads only the words said since its last answer", async () => {
		const ended = {
			role: "user",
			content: "[j1] the command exited 0 after 46 seconds.",
		};
		expect(
			(await answerTo([told, started, handedOff, answered, ended])).calls,
		).toEqual([]);
	});
});

/**
 * Every session is told how to answer its person: once, in its prompt,
 * with no turn of its own and no message after.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	ANSWERING_THE_PERSON,
	registerAnsweringThePerson,
} from "../../../extensions/quest-workflow/wiring/answer-the-person.ts";
import { sectionName } from "../../../lib/prompt/standing.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A pi with one session's log, as far as a standing context reads one. */
function session() {
	const entries: { type: string; customType: string; data: unknown }[] = [];
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ type: "custom", customType, data }),
		events: { on: () => undefined },
	};
	registerAnsweringThePerson(pi as unknown as ExtensionAPI);
	const ctx = {
		sessionManager: { getEntries: () => entries, getBranch: () => entries },
	};
	return {
		start: () => handlers.get("session_start")?.({}, ctx),
		/** One prompt: the section it renders and any message it sends. */
		async prompt() {
			const sections: Record<string, string> = {};
			const turn = (await handlers.get("before_agent_start")?.(
				{
					messageType: "user",
					systemPrompt: "base",
					systemPromptOptions: { sections },
				},
				ctx,
			)) as { message?: unknown } | undefined;
			return {
				section: sections[sectionName("answer-the-person")],
				message: turn?.message,
			};
		},
	};
}

describe("answering the person", () => {
	it("puts the rule in a session's prompt at its first turn, with no message", async () => {
		const one = session();
		await one.start();

		const first = await one.prompt();

		expect(first.section).toContain(ANSWERING_THE_PERSON);
		expect(
			first.message,
			"a live session hears it without a turn",
		).toBeUndefined();
	});

	it("says nothing more on later turns or after a reload, and keeps its bytes", async () => {
		const one = session();
		await one.start();
		const first = await one.prompt();

		const later = await one.prompt();
		await one.start();
		const reloaded = await one.prompt();

		expect([later, reloaded]).toEqual([
			{ section: first.section, message: undefined },
			{ section: first.section, message: undefined },
		]);
	});

	it("says to answer first, and what the whole quest's standing holds", () => {
		expect(ANSWERING_THE_PERSON).toMatch(/say something to him first/);
		for (const part of [
			"what's live on his machines",
			"merged and waiting on a switch",
			"what's open and its date",
			"what waits on him",
		]) {
			expect(ANSWERING_THE_PERSON).toContain(part);
		}
	});
});

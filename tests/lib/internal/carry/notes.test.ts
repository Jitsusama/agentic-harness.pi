/**
 * A quest's notes, carried: its facts read from one machine's memory
 * store and taken up by another's, each once, and nothing of another
 * quest's.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { notesOf, takeNotes } from "../../../../lib/internal/carry/notes.ts";
import type { MemoryStore } from "../../../../lib/memory/index.ts";
import { openMemoryStore } from "../../../../lib/memory/store.ts";

const QUEST = "QEST-20261116-NOTES1";
const OTHER = "QEST-20261116-NOTES2";

let leaving: MemoryStore;
let arriving: MemoryStore;
beforeEach(async () => {
	leaving = await openMemoryStore(":memory:");
	arriving = await openMemoryStore(":memory:");
});
afterEach(async () => {
	await leaving.close();
	await arriving.close();
});

describe("a quest's carried notes", () => {
	it("are its own facts, with their tags and source, and no other quest's or global ones", async () => {
		await leaving.retain({
			scope: { kind: "quest", id: QUEST },
			text: "the gate is host-gate.sh",
			tags: ["gate"],
			source: "AGENTS.md",
		});
		await leaving.retain({
			scope: { kind: "quest", id: OTHER },
			text: "not ours",
		});
		await leaving.retain({ scope: { kind: "global" }, text: "everyone's" });

		expect(await notesOf(leaving, QUEST)).toEqual([
			{ text: "the gate is host-gate.sh", tags: ["gate"], source: "AGENTS.md" },
		]);
	});

	it("are taken up once, however often they arrive, beside what was already known", async () => {
		await arriving.retain({
			scope: { kind: "quest", id: QUEST },
			text: "known here already",
		});
		const notes = [
			{ text: "known here already", tags: [] },
			{ text: "carried", tags: ["move"] },
		];

		const first = await takeNotes(arriving, QUEST, notes);
		const again = await takeNotes(arriving, QUEST, notes);

		expect(first, "only the note it lacked was added").toBe(1);
		expect(again, "arriving again adds nothing").toBe(0);
		const facts = await arriving.active({ kind: "quest", id: QUEST });
		expect(facts.map((fact) => [fact.text, fact.tags])).toEqual([
			["known here already", []],
			["carried", ["move"]],
		]);
		expect(await arriving.active({ kind: "quest", id: OTHER })).toEqual([]);
	});
});

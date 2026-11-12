/**
 * A peer whose quest hears only what is put to it, as Joel's router
 * does: it is in its orchestration's group by lineage, and every other
 * session's landings there would otherwise sit in its context and be
 * read again with each line he says.
 */
import { describe, expect, it } from "vitest";
import { attend, type Standing } from "../../../lib/mesh/attention.ts";
import type { Message } from "../../../lib/mesh/message.ts";
import { orchestrationGroup } from "../../../lib/mesh/scope.ts";

const ROUTER = ["8GYNJ6", "E9DE8111"];
const ORCHESTRATOR = "WCJQSG";

function message(over: Partial<Message> = {}): Message {
	return {
		v: 1,
		id: "1-5FWIUS-1-aaaa",
		at: "2026-11-12T07:40:00.000Z",
		from: "5FWIUS",
		to: [orchestrationGroup(ORCHESTRATOR)],
		text: "merged core.nix #3570, the void's disk guard",
		intent: "fyi",
		pid: 1,
		...over,
	};
}

function standing(hears: "addressed" | undefined, over: Partial<Standing> = {}) {
	return {
		receiver: {
			addresses: ROUTER,
			worksOn: "The Void: Say It Once, It Goes Where It Belongs",
			owns: ["QEST-20261112-8GYNJ6", "void"],
			...(hears ? { hears } : {}),
		},
		idle: true,
		orchestrator: [ORCHESTRATOR],
		...over,
	} satisfies Standing;
}

/** What each message gets from a peer standing so. */
function heard(
	hears: "addressed" | undefined,
	cases: readonly [Partial<Message>, Partial<Standing>?][],
) {
	return cases.map(
		([over, at]) => attend(message(over), standing(hears, at)).attention,
	);
}

describe("a peer that hears only what is put to it", () => {
	const overheard: [Partial<Message>, Partial<Standing>?][] = [
		[{}],
		[{}, { concern: "receiver" }],
		[{ intent: "finding" }],
		[{ intent: "question" }, { concern: "receiver" }],
		[{ intent: "pivot", from: "P0THER" }],
	];

	it("hears other peers' news about its work in full without the setting", () => {
		expect(heard(undefined, overheard), "noted, or acted on").toEqual([
			"note",
			"note",
			"note",
			"act",
			"note",
		]);
	});

	it("glances at what went to a group, however it is judged", () => {
		expect(heard("addressed", overheard), "each a glance").toEqual([
			"glance",
			"glance",
			"glance",
			"glance",
			"glance",
		]);
	});

	it("still hears what is put to it, answers it, holds or pivots it", () => {
		expect(
			heard("addressed", [
				[{ to: ["8GYNJ6"], intent: "question" }],
				[{ to: ["E9DE8111"] }],
				[{}, { answers: true }],
				[{}, { asked: true }],
				[{ intent: "hold" }],
				[{ intent: "pivot", from: ORCHESTRATOR }],
				[{ text: "8GYNJ6: where did that line go?" }],
			]),
			"a turn, a note, a note, a turn, a note, a turn, a note",
		).toEqual(["turn", "note", "note", "turn", "note", "turn", "note"]);
	});
});

import { describe, expect, it } from "vitest";
import {
	type Folding,
	folds,
	keptOffIn,
	quietIn,
	quietWanted,
} from "../../../extensions/mesh-workflow/quiet.ts";

describe("what quiet keeps off the screen", () => {
	it("folds a delivery of only fyis and findings that started no turn", () => {
		const telling: Folding = {
			messages: [{ intent: "fyi" }, { intent: "finding" }],
		};

		expect(folds(telling), "fyis and findings fold").toBe(true);
	});

	it("shows one that asks something, started a turn, or holds no message", () => {
		const shown: [string, Folding | undefined][] = [
			["a question", { messages: [{ intent: "fyi" }, { intent: "question" }] }],
			["a hold", { messages: [{ intent: "hold" }] }],
			["a pivot", { messages: [{ intent: "pivot" }] }],
			["a turn", { messages: [{ intent: "fyi" }], turn: true }],
			[
				"an answer to this peer, its turn held by a pause",
				{ messages: [{ intent: "fyi" }], forThisPeer: true },
			],
			["no message", { messages: [] }],
			["no details", undefined],
		];

		expect(shown.filter(([, delivery]) => folds(delivery))).toEqual([]);
	});
});

describe("the setting in a session's log", () => {
	const set = (on: boolean) => ({
		type: "custom",
		customType: "mesh-quiet",
		data: { on },
	});

	it("reads the latest, and is off when none was ever made", () => {
		expect([
			quietIn([set(true), { type: "message" }]),
			quietIn([set(true), set(false)]),
			quietIn([{ type: "message" }]),
		]).toEqual([true, false, false]);
	});
});

describe("what the footer counts after a reload", () => {
	const set = (on: boolean) => ({
		type: "custom",
		customType: "mesh-quiet",
		data: { on },
	});
	const delivery = (intent: string, turn = false) => ({
		type: "custom_message",
		customType: "mesh",
		details: { messages: [{ intent }, { intent }], turn },
	});

	it("counts the messages kept off since quiet last went on", () => {
		const log = [
			set(true),
			delivery("fyi"),
			set(false),
			delivery("fyi"),
			set(true),
			delivery("finding"),
			delivery("question"),
			delivery("fyi", true),
			{ type: "custom_message", customType: "other", details: {} },
			delivery("fyi"),
		];

		expect([keptOffIn(log), keptOffIn(log.slice(0, 4))]).toEqual([4, 0]);
	});
});

describe("/mesh quiet", () => {
	it("turns it on or off as asked, and the other way when not said", () => {
		expect([
			quietWanted("quiet on", false),
			quietWanted("quiet off", true),
			quietWanted("quiet", false),
			quietWanted(" quiet ", true),
		]).toEqual([true, false, true, false]);
	});

	it("asks nothing of what it doesn't know", () => {
		expect([
			quietWanted("loud", false),
			quietWanted("quiet maybe", false),
			quietWanted("quiet on now", false),
		]).toEqual([undefined, undefined, undefined]);
	});
});

import { describe, expect, it } from "vitest";
import {
	type Folding,
	folds,
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

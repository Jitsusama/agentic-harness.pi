import { describe, expect, it } from "vitest";
import {
	recentContext,
	taggingRequest,
	tagsFrom,
} from "../../../../lib/compaction/selection/tagging.ts";
import {
	readTags,
	untagged,
} from "../../../../lib/compaction/selection/tags.ts";
import { unitsOf } from "../../../../lib/compaction/selection/units.ts";
import { assistant, compaction, tagged, user } from "./fixtures.ts";

describe("taggingRequest", () => {
	const said = user("u1", "Build the classifier.\n\nNever copy upstream code.");
	const reply = assistant("a1", "The tests pass now.");

	it("asks every kind of a user paragraph, and a goal only of a user's", () => {
		const request = taggingRequest(unitsOf(said), []);
		const kinds = Object.keys(request.questions)
			.filter((id) => id.startsWith("u0."))
			.map((id) => id.slice(3));
		expect(kinds).toContain("goal");
		expect(kinds).toHaveLength(9);

		const assistantRequest = taggingRequest(unitsOf(reply), []);
		expect(Object.keys(assistantRequest.questions)).not.toContain("u0.goal");
		expect(Object.keys(assistantRequest.questions)).toHaveLength(8);
	});

	it("sends what came before as context, latest last, within the budget", () => {
		const before = unitsOf(
			user("u0", "First thing said.\n\nSecond thing said."),
		);
		const request = taggingRequest(unitsOf(reply), before, 5);
		expect(request.context.map((unit) => unit.text)).toEqual([
			"Second thing said.",
		]);
		expect(recentContext(before, 1000).map((unit) => unit.text)).toEqual([
			"First thing said.",
			"Second thing said.",
		]);
	});

	it("reads each paragraph's kinds at the threshold", () => {
		const units = unitsOf(said);
		expect(
			tagsFrom(units, { "u0.goal": 0.9, "u1.rule": 0.5, "u1.goal": 0.49 }),
		).toEqual([
			{ hash: units[0]?.hash, kinds: ["goal"] },
			{ hash: units[1]?.hash, kinds: ["rule"] },
		]);
	});
});

describe("untagged", () => {
	it("is the messages after the last compaction with text and no tags", () => {
		const old = user("u0", "Before the compaction.");
		const done = user("u1", "Already tagged here.");
		const todo = assistant("a1", "Still to be tagged.");
		const branch = [
			old,
			compaction("c1"),
			done,
			tagged(done, ["rule"]),
			assistant("a0", ""),
			todo,
		];
		expect(untagged(branch, readTags(branch)).map((e) => e.id)).toEqual(["a1"]);
	});

	it("reads tags back with only the kinds it knows", () => {
		const said = user("u1", "Always sign commits.");
		const entry = tagged(said, ["rule"]);
		(
			entry as { data: { units: { kinds: string[] }[] } }
		).data.units[0]?.kinds.push("nonsense");
		expect(readTags([entry]).get("u1")?.units[0]?.kinds).toEqual(["rule"]);
	});
});

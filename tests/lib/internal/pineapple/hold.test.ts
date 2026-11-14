import { describe, expect, it } from "vitest";
import {
	END_TEXT,
	groupsOf,
	holdText,
	type Kept,
	RENEW_MS,
	tending,
} from "../../../../lib/internal/pineapple/hold.ts";
import { type Stop, stopOf } from "../../../../lib/internal/pineapple/stops.ts";

function stop(id: string, reaches: string[], fields = {}): Stop {
	const made = stopOf({ shadow: false, reaches, ...fields }, id);
	if (!made) throw new Error("a stop with no resume is made");
	return made;
}

const chainOf = (quest: string) =>
	quest === "QEST-CHILD" ? ["QEST-CHILD", "QEST-PARENT"] : [quest];

const NOW = 10 * RENEW_MS;

const kept = (one: Partial<Kept> & { stop: string }): Kept => ({
	hold: `hold-${one.stop}`,
	to: ["#all"],
	at: NOW,
	shadow: false,
	...one,
});

describe("groupsOf", () => {
	it("sends a quest's hold to its group under its parents, as the mesh names it", () => {
		expect(groupsOf(stop("a", ["quest:qest-child"]), chainOf)).toEqual([
			"#quest/parent/child",
		]);
	});

	it("sends a repository's, or a change's in it, to the repository's group", () => {
		expect(
			groupsOf(
				stop("a", ["repo:example/agentic-harness.pi", "pr:example/shop#12"]),
				chainOf,
			),
		).toEqual(["#repo/agentic-harness-pi", "#repo/shop"]);
	});

	it("sends to every session when a reach has no narrower group", () => {
		expect(
			groupsOf(stop("a", ["pr:example/shop#12", "everything"]), chainOf),
		).toEqual(["#all"]);
		expect(groupsOf(stop("a", ["realm:work"]), chainOf)).toEqual(["#all"]);
		expect(groupsOf(stop("a", ["pr:12"]), chainOf)).toEqual(["#all"]);
	});
});

describe("tending", () => {
	const quest = stop("q", ["quest:QEST-CHILD"]);

	it("sends a hold for a stop with none", () => {
		const [step] = tending([quest], [], NOW, "work", chainOf);
		expect(step).toMatchObject({
			kind: "send",
			to: ["#quest/parent/child"],
		});
		expect(step).not.toHaveProperty("supersedes");
	});

	it("leaves a fresh hold, and renews one before its two hours end", () => {
		expect(
			tending(
				[quest],
				[kept({ stop: "q", at: NOW - 60_000 })],
				NOW,
				"work",
				chainOf,
			),
		).toEqual([]);
		const [step] = tending(
			[quest],
			[kept({ stop: "q", at: NOW - RENEW_MS })],
			NOW,
			"work",
			chainOf,
		);
		expect(step).toMatchObject({ kind: "send", supersedes: "hold-q" });
	});

	it("sends a real hold once a shadow stop goes live", () => {
		const [step] = tending(
			[quest],
			[kept({ stop: "q", hold: "", shadow: true })],
			NOW,
			"work",
			chainOf,
		);
		expect(step).toMatchObject({ kind: "send" });
		expect(step).not.toHaveProperty("supersedes");
	});

	it("ends the hold of a stop Joel resumed", () => {
		const gone = kept({ stop: "gone" });
		expect(tending([], [gone], NOW, "work", chainOf)).toEqual([
			{ kind: "end", kept: gone, text: END_TEXT },
		]);
	});

	it("leaves a stop on another realm to that realm's sessions", () => {
		expect(
			tending([stop("h", ["realm:home"])], [], NOW, "work", chainOf),
		).toEqual([]);
		expect(
			tending([stop("w", ["realm:work"])], [], NOW, "work", chainOf),
		).toHaveLength(1);
	});
});

describe("holdText", () => {
	it("says who said what, where, what it stops and who resumes", () => {
		const text = holdText(
			stop("a", ["pr:example/shop#12"], {
				said_by: "U0OTHER001",
				where: "https://example.slack.com/archives/C1/p12",
				words: "<@U0JOEL0001> pineapple   override\non this PR",
			}),
		);
		expect(text).toContain(
			'U0OTHER001 said "<@U0JOEL0001> pineapple override on this PR"',
		);
		expect(text).toContain("stopping example/shop#12");
		expect(text).toContain("Only Joel resumes it");
		expect(text).toContain("carry on with other work");
	});

	it("says sessions are parked for anything wider than one change", () => {
		expect(holdText(stop("a", ["quest:QEST-CHILD"]))).toContain(
			"sessions in it are parked",
		);
	});
});

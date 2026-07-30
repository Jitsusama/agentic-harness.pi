import { describe, expect, it } from "vitest";
import { parseParticipant, parseRoster } from "../../../lib/review/index.js";

/** The refusal, or a thrown error naming what came back instead. */
function refusalOf(outcome: object): string {
	if ("refusal" in outcome && typeof outcome.refusal === "string") {
		return outcome.refusal;
	}
	throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
}

describe("one participant", () => {
	it("takes an id on its own", () => {
		expect(parseParticipant({ id: "hawk" }, "reviewers[0]")).toEqual({
			participant: { id: "hawk" },
		});
	});

	it("names itself after its persona when it has no id of its own", () => {
		// Naming a reviewer twice to say one thing is noise, and the
		// persona is the more meaningful of the two names.
		expect(parseParticipant({ persona: "architect" }, "reviewers[0]")).toEqual({
			participant: { id: "architect", persona: "architect" },
		});
	});

	it("lets an explicit id override the persona's", () => {
		// So the same persona can run twice at different settings,
		// which is the whole reason the override exists.
		expect(
			parseParticipant(
				{ id: "architect-high", persona: "architect", thinkingLevel: "high" },
				"reviewers[0]",
			),
		).toEqual({
			participant: {
				id: "architect-high",
				persona: "architect",
				thinkingLevel: "high",
			},
		});
	});

	it("keeps model and tools as given", () => {
		expect(
			parseParticipant(
				{ id: "hawk", model: "anthropic/opus", tools: ["read", "grep"] },
				"reviewers[0]",
			),
		).toEqual({
			participant: {
				id: "hawk",
				model: "anthropic/opus",
				tools: ["read", "grep"],
			},
		});
	});

	it("refuses a participant that is not an object, naming where", () => {
		expect(refusalOf(parseParticipant("hawk", "reviewers[2]"))).toContain(
			"reviewers[2]",
		);
	});

	it("refuses one with neither id nor persona, and says what to add", () => {
		const refusal = refusalOf(parseParticipant({ model: "m" }, "judge"));
		expect(refusal).toContain("judge");
		expect(refusal).toMatch(/id/);
		expect(refusal).toMatch(/persona/);
	});

	it("refuses an empty or blank id rather than holding whitespace", () => {
		expect(
			refusalOf(parseParticipant({ id: "   " }, "reviewers[0]")),
		).toContain("reviewers[0]");
	});

	it("refuses a model that is not a string", () => {
		expect(
			refusalOf(parseParticipant({ id: "hawk", model: 7 }, "reviewers[0]")),
		).toContain("model");
	});

	it("refuses a tools list holding something that is not a string", () => {
		expect(
			refusalOf(
				parseParticipant({ id: "hawk", tools: ["read", 7] }, "reviewers[0]"),
			),
		).toContain("tools");
	});

	it("refuses a model spelled with a colon, naming the separator", () => {
		// Pi reads a colon as a thinking-level separator, so a model
		// carrying one silently becomes a different request. Better to
		// refuse and say why than to send something nobody wrote.
		const refusal = refusalOf(
			parseParticipant({ id: "hawk", model: "anthropic:opus" }, "reviewers[0]"),
		);
		expect(refusal).toMatch(/colon|thinking/i);
	});
});

describe("a whole roster", () => {
	it("takes reviewers and a judge", () => {
		expect(
			parseRoster({
				reviewers: [{ id: "hawk" }, { id: "owl" }],
				judge: { id: "wren" },
			}),
		).toEqual({
			roster: {
				reviewers: [{ id: "hawk" }, { id: "owl" }],
				judge: { id: "wren" },
			},
		});
	});

	it("takes reviewers alone", () => {
		expect(parseRoster({ reviewers: [{ id: "hawk" }] })).toEqual({
			roster: { reviewers: [{ id: "hawk" }] },
		});
	});

	it("refuses a roster that is not an object", () => {
		expect(refusalOf(parseRoster([]))).toMatch(/object/i);
	});

	it("refuses a roster with no reviewers at all", () => {
		// A council of nobody is not a smaller council, and running one
		// would report success having asked no one.
		const refusal = refusalOf(parseRoster({ reviewers: [] }));
		expect(refusal).toMatch(/at least one|no reviewers|empty/i);
	});

	it("refuses a roster that never mentions reviewers", () => {
		expect(refusalOf(parseRoster({ judge: { id: "wren" } }))).toMatch(
			/reviewers/,
		);
	});

	it("refuses reviewers that is not an array", () => {
		expect(refusalOf(parseRoster({ reviewers: { id: "hawk" } }))).toMatch(
			/array/i,
		);
	});

	it("refuses two reviewers sharing an id, naming it", () => {
		// Two participants under one name make every origin that
		// mentions it ambiguous, which is the thing the identity
		// ledger exists to prevent. Cheaper to catch here.
		const refusal = refusalOf(
			parseRoster({ reviewers: [{ id: "hawk" }, { id: "hawk" }] }),
		);
		expect(refusal).toContain("hawk");
	});

	it("catches a duplicate that only appears after persona naming", () => {
		// One entry named by persona and one named explicitly can
		// collide, and the collision is invisible in the raw config.
		const refusal = refusalOf(
			parseRoster({
				reviewers: [{ persona: "architect" }, { id: "architect" }],
			}),
		);
		expect(refusal).toContain("architect");
	});

	it("refuses a judge sharing an id with a reviewer", () => {
		// The judge reads the reviewers' findings. Sharing a name makes
		// the consolidation indistinguishable from what it consolidated.
		const refusal = refusalOf(
			parseRoster({
				reviewers: [{ id: "hawk" }],
				judge: { id: "hawk" },
			}),
		);
		expect(refusal).toContain("hawk");
	});

	it("passes a reviewer's own refusal through, path and all", () => {
		expect(
			refusalOf(parseRoster({ reviewers: [{ id: "hawk" }, { model: "m" }] })),
		).toContain("reviewers[1]");
	});

	it("names the judge in its refusal rather than an index", () => {
		expect(
			refusalOf(
				parseRoster({ reviewers: [{ id: "hawk" }], judge: { model: "m" } }),
			),
		).toContain("judge");
	});
});

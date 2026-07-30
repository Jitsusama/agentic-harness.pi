import { describe, expect, it } from "vitest";
import type { Finding } from "../../../lib/review/index.js";
import {
	attributedTo,
	createIdentityLedger,
	participantIdentity,
} from "../../../lib/review/index.js";

const anchor = { subject: "change" } as const;

function finding(over: Partial<Finding> = {}): Finding {
	return {
		id: 1,
		anchor,
		label: "issue",
		subject: "s",
		discussion: "d",
		origin: { kind: "hand" },
		...over,
	};
}

const byReviewer = (reviewerId: string, runId = "r1"): Finding =>
	finding({ origin: { kind: "reviewer", runId, reviewerId } });

describe("what a participant id means", () => {
	it("carries only the fields that were actually set", () => {
		expect(participantIdentity("reviewer", { id: "hawk" })).toEqual({
			id: "hawk",
			role: "reviewer",
		});
	});

	it("keeps the mechanism settings that distinguish two runs", () => {
		expect(
			participantIdentity("judge", {
				id: "owl",
				model: "anthropic/opus",
				thinkingLevel: "high",
				tools: ["read", "grep"],
				persona: "architect",
			}),
		).toEqual({
			id: "owl",
			role: "judge",
			model: "anthropic/opus",
			thinkingLevel: "high",
			tools: ["read", "grep"],
			persona: "architect",
		});
	});
});

describe("whether a finding is attributed to an id", () => {
	it("reads a reviewer origin", () => {
		expect(attributedTo(byReviewer("hawk"), "hawk")).toBe(true);
		expect(attributedTo(byReviewer("hawk"), "owl")).toBe(false);
	});

	it("reads a judge origin", () => {
		const judged = finding({
			origin: { kind: "judge", runId: "r2", reviewerId: "owl" },
		});
		expect(attributedTo(judged, "owl")).toBe(true);
	});

	it("never attributes a hand-written finding to anyone", () => {
		expect(attributedTo(finding(), "hawk")).toBe(false);
	});

	it("counts an id named only in raisedBy", () => {
		// A judge finding records which reviewers raised the same
		// thing. Missing those would let a release claim no finding
		// references an id when several name it as agreement.
		const consolidated = finding({
			origin: { kind: "judge", runId: "r2", reviewerId: "owl" },
			raisedBy: ["hawk", "wren"],
		});
		expect(attributedTo(consolidated, "hawk")).toBe(true);
		expect(attributedTo(consolidated, "wren")).toBe(true);
		expect(attributedTo(consolidated, "crow")).toBe(false);
	});
});

describe("claiming an id", () => {
	it("lets a new id be claimed", () => {
		const ledger = createIdentityLedger();

		const outcome = ledger.claim("reviewer", { id: "hawk" }, []);

		expect(outcome).toEqual({ held: { id: "hawk", role: "reviewer" } });
		expect(ledger.held()).toEqual([{ id: "hawk", role: "reviewer" }]);
	});

	it("lets the same identity be re-claimed", () => {
		const ledger = createIdentityLedger();
		const hawk = { id: "hawk", model: "m" };
		ledger.claim("reviewer", hawk, []);

		expect(ledger.claim("reviewer", hawk, [byReviewer("hawk")])).toEqual({
			held: { id: "hawk", role: "reviewer", model: "m" },
		});
	});

	it("re-points an id that never produced anything, without complaint", () => {
		// The audit trail only matters where there is output to
		// attribute. Refusing here would make reconfiguring a roster
		// nobody has run yet needlessly painful.
		const ledger = createIdentityLedger();
		ledger.claim("reviewer", { id: "hawk", model: "sonnet" }, []);

		const outcome = ledger.claim("reviewer", { id: "hawk", model: "opus" }, []);

		expect(outcome).toEqual({
			held: { id: "hawk", role: "reviewer", model: "opus" },
		});
	});

	it("refuses to let an id that has findings mean a different model", () => {
		const ledger = createIdentityLedger();
		ledger.claim("reviewer", { id: "hawk", model: "sonnet" }, []);

		const outcome = ledger.claim("reviewer", { id: "hawk", model: "opus" }, [
			byReviewer("hawk"),
		]);

		if (!("refusal" in outcome)) throw new Error("expected a refusal");
		expect(outcome.refusal).toContain("hawk");
		expect(outcome.refusal).toContain("sonnet");
		expect(outcome.refusal).toContain("opus");
	});

	it("names both ways out when it refuses", () => {
		// A refusal that only names the rule leaves the caller to
		// guess. There are exactly two moves here, and both belong in
		// the sentence.
		const ledger = createIdentityLedger();
		ledger.claim("reviewer", { id: "hawk", model: "sonnet" }, []);

		const outcome = ledger.claim("reviewer", { id: "hawk", model: "opus" }, [
			byReviewer("hawk"),
		]);

		if (!("refusal" in outcome)) throw new Error("expected a refusal");
		expect(outcome.refusal).toMatch(/different id|another id|new id/i);
		expect(outcome.refusal).toMatch(/release/i);
	});

	it("refuses when the role changes under a claimed id", () => {
		// Same model, same everything, but a judge and a reviewer are
		// different participants and a reader of the origins has no
		// way to tell them apart afterwards.
		const ledger = createIdentityLedger();
		ledger.claim("reviewer", { id: "hawk", model: "m" }, []);

		const outcome = ledger.claim("judge", { id: "hawk", model: "m" }, [
			byReviewer("hawk"),
		]);

		expect("refusal" in outcome).toBe(true);
	});

	it("refuses on a thinking level change, since it changes the answer", () => {
		const ledger = createIdentityLedger();
		ledger.claim("reviewer", { id: "hawk", thinkingLevel: "low" }, []);

		const outcome = ledger.claim(
			"reviewer",
			{ id: "hawk", thinkingLevel: "high" },
			[byReviewer("hawk")],
		);

		expect("refusal" in outcome).toBe(true);
	});

	it("treats a reordered tool palette as the same palette", () => {
		// The set is what changes what a reviewer can do. Order does
		// not, and refusing on it would be a false alarm.
		const ledger = createIdentityLedger();
		ledger.claim("reviewer", { id: "hawk", tools: ["read", "grep"] }, []);

		const outcome = ledger.claim(
			"reviewer",
			{ id: "hawk", tools: ["grep", "read"] },
			[byReviewer("hawk")],
		);

		expect("refusal" in outcome).toBe(false);
	});

	it("refuses when the palette really differs", () => {
		const ledger = createIdentityLedger();
		ledger.claim("reviewer", { id: "hawk", tools: ["read"] }, []);

		const outcome = ledger.claim(
			"reviewer",
			{ id: "hawk", tools: ["read", "bash"] },
			[byReviewer("hawk")],
		);

		expect("refusal" in outcome).toBe(true);
	});

	it("ignores findings belonging to other ids", () => {
		const ledger = createIdentityLedger();
		ledger.claim("reviewer", { id: "hawk", model: "sonnet" }, []);

		const outcome = ledger.claim("reviewer", { id: "hawk", model: "opus" }, [
			byReviewer("owl"),
			finding(),
		]);

		expect("refusal" in outcome).toBe(false);
	});
});

describe("releasing an id", () => {
	it("frees a held id so it can mean something else", () => {
		const ledger = createIdentityLedger();
		ledger.claim("reviewer", { id: "hawk", model: "sonnet" }, []);

		expect(ledger.release("hawk")).toBe(true);
		expect(ledger.held()).toEqual([]);
		expect(
			ledger.claim("reviewer", { id: "hawk", model: "opus" }, [
				byReviewer("hawk"),
			]),
		).toEqual({ held: { id: "hawk", role: "reviewer", model: "opus" } });
	});

	it("says so when there was nothing to release", () => {
		expect(createIdentityLedger().release("nobody")).toBe(false);
	});
});

import { describe, expect, it } from "vitest";
import {
	type StandingContextLedger,
	type StandingContextWording,
	standingContextAfterCompaction,
	standingContextTurn,
} from "../../../lib/prompt/index.ts";
import { sectionName } from "../../../lib/prompt/standing.ts";

const WORDING: StandingContextWording = {
	customType: "probe-context",
	inPrompt: (text) => `\n\n[Probe] ${text}`,
	changed: (text) =>
		`[Probe] Now: ${text ?? "nothing is loaded."} This supersedes the earlier probe context.`,
};

function turn(ledger: StandingContextLedger, current: string | null) {
	return standingContextTurn(WORDING, ledger, current);
}

describe("standingContextTurn", () => {
	it("puts the context in its prompt section on the first turn", () => {
		const first = turn({}, "Quest QEST-1 loaded.");
		expect(first.section).toBe("[Probe] Quest QEST-1 loaded.");
		expect(first.message).toBeUndefined();
	});

	it("keeps the section byte-identical when the state changes", () => {
		const first = turn({}, "Quest QEST-1 loaded.");
		const later = turn(first.ledger, "Quest QEST-1 loaded. Focused: PLAN-1.");
		expect(later.section).toBe(first.section);
	});

	it("says what changed once, in a hidden message worded by the caller", () => {
		const first = turn({}, "Quest QEST-1 loaded.");
		const current = "Quest QEST-1 loaded. Focused: PLAN-1.";
		const later = turn(first.ledger, current);
		expect(later.message).toEqual({
			customType: "probe-context",
			content: `[Probe] Now: ${current} This supersedes the earlier probe context.`,
			display: false,
		});
		expect(turn(later.ledger, current).message).toBeUndefined();
	});

	it("says so when the state is cleared, keeping the frozen text", () => {
		const first = turn({}, "Quest QEST-1 loaded.");
		const later = turn(first.ledger, null);
		expect(later.section).toBe(first.section);
		expect(later.message?.content).toContain("nothing is loaded.");
	});

	it("leaves the prompt alone and sends a message for state that arrives mid-session", () => {
		const first = turn({}, null);
		expect(first.section).toBeUndefined();
		const later = turn(first.ledger, "Quest QEST-1 loaded.");
		expect(later.section).toBeUndefined();
		expect(later.message?.content).toContain("Quest QEST-1 loaded.");
	});

	it("says the current state again after a compaction summarised the message away", () => {
		const first = turn({}, "Quest QEST-1 loaded.");
		const current = "Quest QEST-1 loaded. Focused: PLAN-1.";
		const told = turn(first.ledger, current);
		const after = turn(standingContextAfterCompaction(told.ledger), current);
		expect(after.section).toBe(first.section);
		expect(after.message?.content).toContain(current);
	});

	it("sends nothing after a compaction when the state is still the frozen one", () => {
		const first = turn({}, "Quest QEST-1 loaded.");
		const after = turn(
			standingContextAfterCompaction(first.ledger),
			"Quest QEST-1 loaded.",
		);
		expect(after.message).toBeUndefined();
	});
});

describe("sectionName", () => {
	it("names a section in the characters pi allows", () => {
		expect(sectionName("quest-context")).toBe("quest-context");
		expect(sectionName("Slack Identity")).toBe("slack_identity");
		expect(sectionName("1st")).toBe("standing_1st");
	});
});

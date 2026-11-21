import type {
	ClassifierContext,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { Classify } from "../../../lib/classifier/jev.ts";
import {
	claimParts,
	UNTESTED_FLOOR,
	untestedCauseReason,
	untestedCauses,
} from "../../../lib/prose/claims.ts";

/** A classifier giving each part the sureness `of` says. */
function judging(of: (part: string) => number): Classify {
	return async (context: ClassifierContext) => {
		const untested = of(String(context.state["message"]));
		return {
			stopReason: "stop",
			answers: {
				cause: {
					type: "choice",
					choice: untested >= 0.5 ? "untested_cause" : "no_cause",
					probabilities: { untested_cause: untested, no_cause: 1 - untested },
					confidence: Math.max(untested, 1 - untested),
				},
			},
		} as unknown as ClassifierResult;
	};
}

describe("claimParts", () => {
	it("judges each paragraph and each bullet, past a few words", () => {
		const text = [
			"The deploy stalled at 14:02 and I restarted it.",
			"",
			"- **Why:** the builder's disk filled with old store paths.",
			"- ok",
			"- **Next:** a nightly sweep of the store keeps it clear.",
		].join("\n");
		expect(claimParts(text)).toEqual([
			"The deploy stalled at 14:02 and I restarted it.",
			"- **Why:** the builder's disk filled with old store paths.",
			"- **Next:** a nightly sweep of the store keeps it clear.",
		]);
	});

	it("judges at most twelve parts of a long text", () => {
		const text = Array.from(
			{ length: 20 },
			(_, i) => `Paragraph ${i} says something long enough to judge.`,
		).join("\n\n");
		expect(claimParts(text)).toHaveLength(12);
	});
});

describe("untestedCauses", () => {
	const text = [
		"Merged #12 at 4f2a, and the 40 tests it touches pass.",
		"",
		"The builder failed because its disk filled up with old paths.",
	].join("\n");

	it("finds a part the classifier is sure states an untested cause", async () => {
		const found = await untestedCauses(
			text,
			judging((part) => (part.includes("disk") ? 0.97 : 0.04)),
		);
		expect(found).toEqual([
			"The builder failed because its disk filled up with old paths.",
		]);
	});

	it("lets a part through just under the floor", async () => {
		const found = await untestedCauses(
			text,
			judging((part) => (part.includes("disk") ? UNTESTED_FLOOR - 0.01 : 0)),
		);
		expect(found).toEqual([]);
	});

	it("finds nothing when the classifier fails, stops short or answers oddly", async () => {
		const failing: Classify = vi.fn(async () => {
			throw new Error("the network has gone");
		});
		const stopped: Classify = async () =>
			({ stopReason: "error", answers: {} }) as unknown as ClassifierResult;
		const odd: Classify = async () =>
			({
				stopReason: "stop",
				answers: { cause: { probabilities: "sure" } },
			}) as unknown as ClassifierResult;
		expect(await untestedCauses(text, failing)).toEqual([]);
		expect(await untestedCauses(text, stopped)).toEqual([]);
		expect(await untestedCauses(text, odd)).toEqual([]);
		expect(failing).toHaveBeenCalledTimes(2);
	});
});

describe("untestedCauseReason", () => {
	it("quotes what it found and says how to word it instead", () => {
		const reason = untestedCauseReason([
			"The builder failed because its disk filled up.",
		]);
		expect(reason).toContain(
			"> The builder failed because its disk filled up.",
		);
		expect(reason).toContain('"on trial"');
		expect(reason).toContain(
			"cite the finding that tested it: two independent methods, and an attempt to break it that it survived.",
		);
	});

	it("cuts a long part where it quotes it", () => {
		const reason = untestedCauseReason([`because ${"x".repeat(400)}`]);
		const quoted = reason.split("\n").find((line) => line.startsWith("> "));
		expect(quoted?.length).toBe(2 + 240 + 3);
		expect(quoted?.endsWith("...")).toBe(true);
	});
});

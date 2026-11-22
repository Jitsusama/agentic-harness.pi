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
	untestedCausesFound,
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

	it("judges a long text in twelve parts, the last holding the rest", () => {
		const text = Array.from(
			{ length: 20 },
			(_, i) => `Paragraph ${i} says something long enough to judge.`,
		).join("\n\n");
		const parts = claimParts(text);
		expect(parts).toHaveLength(12);
		expect(parts[11]).toContain("Paragraph 11 ");
		expect(parts[11]).toContain("Paragraph 19 ");
	});

	it("judges each item of a numbered list, and other bullets", () => {
		const text = [
			"Where the run stands:",
			"1. Merged #12 at 4f2a this morning.",
			"2) The builder failed because its disk filled.",
			"+ The sweep is queued for tonight.",
			"\u2022 Nothing waits on the person.",
		].join("\n");
		expect(claimParts(text)).toEqual([
			"Where the run stands:",
			"1. Merged #12 at 4f2a this morning.",
			"2) The builder failed because its disk filled.",
			"+ The sweep is queued for tonight.",
			"\u2022 Nothing waits on the person.",
		]);
	});

	it("judges a terse cause", () => {
		expect(claimParts("Root cause: disk full.")).toEqual([
			"Root cause: disk full.",
		]);
	});

	it("judges a part of 12 characters, and none shorter", () => {
		expect(claimParts("Disk is full\n\nDisk at 99%")).toEqual(["Disk is full"]);
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

	it("finds a part judged exactly at the floor", async () => {
		const found = await untestedCauses(
			text,
			judging((part) => (part.includes("disk") ? UNTESTED_FLOOR : 0)),
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

	it("finds nothing once a classifier that never answers has had 2.5 seconds", async () => {
		vi.useFakeTimers();
		try {
			const hung: Classify = () => new Promise(() => {});
			const judged = untestedCauses(text, hung);
			await vi.advanceTimersByTimeAsync(2500);
			expect(await judged).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("still judges a part the classifier answers within 2 seconds", async () => {
		vi.useFakeTimers();
		try {
			const sure = judging((part) => (part.includes("disk") ? 0.97 : 0));
			const slow: Classify = (context, signal) =>
				new Promise((resolve) => {
					setTimeout(() => resolve(sure(context, signal)), 2000);
				});
			const judged = untestedCauses(text, slow);
			await vi.advanceTimersByTimeAsync(2000);
			expect(await judged).toEqual([
				"The builder failed because its disk filled up with old paths.",
			]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("untestedCausesFound", () => {
	const cause = "The builder failed because its disk filled up with old paths.";

	it("judges with the classifier found", async () => {
		const found = await untestedCausesFound(
			cause,
			Promise.resolve({
				ok: true,
				classify: judging(() => 0.97),
				label: "typesafe/jev-latest",
			} as const),
		);
		expect(found).toEqual([cause]);
	});

	it("finds nothing with no classifier, or none found in 2.5 seconds", async () => {
		expect(await untestedCausesFound(cause, undefined)).toEqual([]);
		vi.useFakeTimers();
		try {
			const judged = untestedCausesFound(cause, new Promise(() => {}));
			await vi.advanceTimersByTimeAsync(2500);
			expect(await judged).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
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
		expect(quoted).toMatch(/\.\.\.$/);
	});
});

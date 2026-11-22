import type {
	ClassifierContext,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { Classify } from "../../../lib/classifier/jev.ts";
import {
	claimParts,
	SLOW_LOOKUP,
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

	it("packs a text past twelve paragraphs into parts in order, all of it read", () => {
		const paragraphs = Array.from(
			{ length: 60 },
			(_, i) => `Paragraph ${i} says something long enough to judge.`,
		);
		const parts = claimParts(paragraphs.join("\n\n"));
		expect(parts).toHaveLength(2);
		expect(parts.join("\n\n")).toBe(paragraphs.join("\n\n"));
		expect(parts.filter((part) => part.length > 2000)).toEqual([]);
	});

	it("reads a list of 40 items whole, though it has more items than parts", async () => {
		const items = Array.from(
			{ length: 40 },
			(_, i) => `- Item ${i} of the digest, ${"with its details ".repeat(5)}`,
		);
		let inFull = 0;
		const told: string[] = [];
		await untestedCauses(
			items.join("\n"),
			judging(() => 0),
			(why) => told.push(why),
			() => {
				inFull += 1;
			},
		);
		expect(told).toEqual([]);
		expect(inFull).toBe(1);
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

	it("packs what follows twelve paragraphs into parts of at most 2000 characters", () => {
		const paragraphs = [
			...Array.from({ length: 11 }, (_, i) => `Paragraph ${i} is short.`),
			...Array.from({ length: 3 }, (_, i) =>
				`Long ${i}: ${"notes ".repeat(182)}`.trim(),
			),
		];
		const parts = claimParts(paragraphs.join("\n\n"));
		expect(parts.join("\n\n"), "none of it left out").toBe(
			paragraphs.join("\n\n"),
		);
		expect(parts.length).toBeLessThanOrEqual(12);
		expect(parts.filter((part) => part.length > 2000)).toEqual([]);
		expect(parts.at(-1), "the last long paragraph a part of its own").toBe(
			paragraphs.at(-1),
		);
	});

	it("judges a long part in stretches broken at sentence ends, none of it left out", () => {
		const part = "The disk filled. ".repeat(300).trim();
		const parts = claimParts(part);
		expect(parts).toHaveLength(3);
		expect(parts.join(" "), "each break falls on a space").toBe(part);
		expect(parts.filter((stretch) => stretch.length > 2000)).toEqual([]);
	});

	it("breaks a stretch with no space at 2000 characters", () => {
		expect(claimParts("a".repeat(4500))).toEqual([
			"a".repeat(2000),
			"a".repeat(2000),
			"a".repeat(500),
		]);
	});

	it("breaks a stretch after a sentence's end rather than at a later space", () => {
		const sentence = "It failed because its disk filled.";
		const part =
			`${"word ".repeat(380)}${sentence} ${"more ".repeat(100)}`.trim();
		const [first, ...rest] = claimParts(part);
		expect(first?.endsWith(sentence), first?.slice(-60)).toBe(true);
		expect([first, ...rest].join(" ")).toBe(part);
	});

	it("leaves no scrap too short to judge where a long part ends", () => {
		const part = `Disk ${"x".repeat(1996)}`;
		const parts = claimParts(part);
		expect(parts.join(""), "none of it left out").toBe(part);
		expect(parts.map((stretch) => stretch.length)).toEqual([1989, 12]);
	});

	it("keeps a part of exactly 2000 characters whole", () => {
		const part = `Disk ${"x".repeat(1995)}`;
		expect(claimParts(part)).toEqual([part]);
	});

	it("never cuts a character in half where a stretch ends", () => {
		const part = `${"x".repeat(1999)}\u{1F4A5}${"y".repeat(500)}`;
		expect(claimParts(part)).toEqual([
			"x".repeat(1999),
			`\u{1F4A5}${"y".repeat(500)}`,
		]);
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

	it("says why a part went unjudged, the first reason of several", async () => {
		const failing: Classify = async () => {
			throw new Error("the network has gone");
		};
		const stopped: Classify = async () =>
			({ stopReason: "error", answers: {} }) as unknown as ClassifierResult;
		const told: [string, string?][] = [];
		const tell = (why: string, detail?: string) =>
			told.push(detail === undefined ? [why] : [why, detail]);
		const stoppedSaying: Classify = async () =>
			({
				stopReason: "error",
				errorMessage: "429 too many requests\nretry after 30 s",
				answers: {},
			}) as unknown as ClassifierResult;
		await untestedCauses(text, failing, tell);
		await untestedCauses(text, stopped, tell);
		await untestedCauses(text, stoppedSaying, tell);
		expect(told).toEqual([
			["a part went unjudged: the classifier failed", "the network has gone"],
			["a part went unjudged: the classifier stopped: error"],
			[
				"a part went unjudged: the classifier stopped: error",
				"429 too many requests",
			],
		]);
	});

	it("keeps what went wrong out of why, so two errors are one reason", async () => {
		const failingWith =
			(said: string): Classify =>
			async () => {
				throw new Error(said);
			};
		const whys = new Set<string>();
		const details: string[] = [];
		const tell = (why: string, detail?: string) => {
			whys.add(why);
			if (detail) details.push(detail);
		};
		await untestedCauses(text, failingWith("request 41 failed"), tell);
		await untestedCauses(
			text,
			failingWith(`request 42 failed\n${"y".repeat(400)}`),
			tell,
		);
		expect([...whys]).toEqual(["a part went unjudged: the classifier failed"]);
		expect(details).toEqual(["request 41 failed", "request 42 failed"]);
	});

	it("reads a signal that ran out as no answer, not a failure", async () => {
		const aborted: Classify = async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		};
		const abortedByFetch: Classify = async () => {
			throw new DOMException("This operation was aborted", "AbortError");
		};
		const stoppedAborted: Classify = async () =>
			({ stopReason: "aborted", answers: {} }) as unknown as ClassifierResult;
		const told: string[] = [];
		await untestedCauses(text, aborted, (why) => told.push(why));
		await untestedCauses(text, stoppedAborted, (why) => told.push(why));
		await untestedCauses(text, abortedByFetch, (why) => told.push(why));
		expect(told).toEqual([
			"a part went unjudged: no answer in 2500 ms",
			"a part went unjudged: no answer in 2500 ms",
			"a part went unjudged: no answer in 2500 ms",
		]);
	});

	it("finds what it judged when another part went unjudged", async () => {
		const sure = judging(() => 0.97);
		const halfway: Classify = async (context, signal) => {
			if (String(context.state["message"]).includes("Merged"))
				throw new Error("the network has gone");
			return sure(context, signal);
		};
		const told: string[] = [];
		const found = await untestedCauses(text, halfway, (why) => told.push(why));
		expect(found).toEqual([
			"The builder failed because its disk filled up with old paths.",
		]);
		expect(told).toEqual(["a part went unjudged: the classifier failed"]);
	});

	it("finds a cause anywhere in a part past 2000 characters, its middle too", async () => {
		const notes = "Notes from the run. ".repeat(150);
		const long = `${notes}It failed because its disk filled. ${notes}`;
		const told: string[] = [];
		const found = await untestedCauses(
			long,
			judging((part) => (part.includes("because") ? 0.97 : 0)),
			(why) => told.push(why),
		);
		expect(found).toHaveLength(1);
		expect(told).toEqual([]);
	});

	it("judges the first 11 parts and the last of a text past 12, and says so", async () => {
		const long = `It began at noon. ${"Notes from the run. ".repeat(1300)}It failed because its disk filled.`;
		const judged: string[] = [];
		const told: string[] = [];
		const sure = judging((part) => (part.includes("because") ? 0.97 : 0));
		const found = await untestedCauses(
			long,
			async (context, signal) => {
				judged.push(String(context.state["message"]));
				return await sure(context, signal);
			},
			(why) => told.push(why),
		);
		expect(judged).toHaveLength(12);
		expect(judged[0]?.startsWith("It began at noon.")).toBe(true);
		expect(found).toHaveLength(1);
		expect(found[0]?.endsWith("It failed because its disk filled.")).toBe(true);
		expect(told).toEqual(["a text ran past 12 parts"]);
	});

	it("finds a cause closing a text after a long pasted log", async () => {
		const log = "line of the build log ".repeat(1400).trim();
		const found = await untestedCauses(
			`${log}\n\nThe build failed because the disk filled.`,
			judging((part) => (part.includes("because") ? 0.97 : 0)),
		);
		expect(found).toHaveLength(1);
		expect(
			found[0]?.endsWith("The build failed because the disk filled."),
		).toBe(true);
	});

	it("says it judged in full only when a part was judged and none missed", async () => {
		let inFull = 0;
		const counting = () => {
			inFull += 1;
		};
		const failing: Classify = async () => {
			throw new Error("the network has gone");
		};
		await untestedCauses(
			text,
			judging(() => 0),
			undefined,
			counting,
		);
		expect(inFull).toBe(1);
		await untestedCauses(text, failing, undefined, counting);
		await untestedCauses(
			"Notes from the run. ".repeat(1300),
			judging(() => 0),
			undefined,
			counting,
		);
		await untestedCauses(
			"ok",
			judging(() => 0),
			undefined,
			counting,
		);
		await untestedCausesFound(
			text,
			Promise.resolve({ ok: false, reason: "off", off: true } as const),
			undefined,
			counting,
		);
		expect(inFull).toBe(1);
	});

	it("says nothing when every part is judged", async () => {
		const told: string[] = [];
		await untestedCauses(
			text,
			judging(() => 0.97),
			(why) => told.push(why),
		);
		expect(told).toEqual([]);
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

	it("says why it judged nothing, but not of a classifier switched off", async () => {
		const told: [string, string?][] = [];
		const tell = (why: string, detail?: string) =>
			told.push(detail === undefined ? [why] : [why, detail]);
		await untestedCausesFound(
			cause,
			Promise.resolve({ ok: false, reason: "none set" } as const),
			tell,
		);
		await untestedCausesFound(
			cause,
			Promise.resolve({ ok: false, reason: "off", off: true } as const),
			tell,
		);
		await untestedCausesFound(
			cause,
			Promise.resolve({ ok: false, reason: SLOW_LOOKUP } as const),
			tell,
		);
		await untestedCausesFound(
			cause,
			Promise.resolve({
				ok: false,
				reason: `refused github_pat_${"A1".repeat(20)}`,
			} as const),
			tell,
		);
		vi.useFakeTimers();
		try {
			const judged = untestedCausesFound(cause, new Promise(() => {}), tell);
			await vi.advanceTimersByTimeAsync(2500);
			await judged;
		} finally {
			vi.useRealTimers();
		}
		expect(told[0]).toEqual(["no classifier", "none set"]);
		expect(told[1], "a session's slow lookup says so").toEqual([
			"finding the classifier took over 2500 ms",
		]);
		expect(told[2]?.[1], "a secret in the detail").not.toContain("github_pat_");
		expect(told[3]).toEqual(["finding the classifier took over 2500 ms"]);
		expect(told).toHaveLength(4);
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

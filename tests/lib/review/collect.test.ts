import { describe, expect, it } from "vitest";
import type { AskAnswer, AskRun, Finding } from "../../../lib/review/index.js";
import { collectRound } from "../../../lib/review/index.js";

/** A reviewer answer carrying one finding about a file. */
function said(subject: string): string {
	return JSON.stringify({
		findings: [
			{
				location: { kind: "file", file: "lib/a.ts" },
				label: "issue",
				subject,
				discussion: "because",
			},
		],
	});
}

/** A round that opened and never closed, as the ledger would hold it. */
function unsettled(over: Partial<AskRun> = {}): AskRun {
	return {
		id: "council-20260806000000000-000001",
		round: "council",
		startedAt: "2026-08-06T00:00:00.000Z",
		participants: [
			{ id: "hawk", role: "reviewer" },
			{ id: "owl", role: "reviewer" },
		],
		outcomes: [],
		open: true,
		...over,
	};
}

/** A recorder that numbers findings the way the real store does. */
function recorder(into: Finding[] = []) {
	let issued = 0;
	return {
		kept: into,
		async record(findings: readonly Omit<Finding, "id">[]) {
			const numbered = findings.map((finding) => ({
				...finding,
				id: ++issued,
			}));
			into.push(...numbered);
			return numbered;
		},
	};
}

const answers = (entries: Record<string, AskAnswer>) =>
	new Map(Object.entries(entries));

describe("collecting a round nobody was there to finish", () => {
	it("records what the reviewers left behind", async () => {
		const keeper = recorder();

		const { run } = await collectRound(
			unsettled(),
			answers({ hawk: { text: said("a") }, owl: { text: said("b") } }),
			keeper,
		);

		expect(keeper.kept.map((f) => f.subject)).toEqual(["a", "b"]);
		expect(run.outcomes.map((o) => o.findingIds)).toEqual([[1], [2]]);
	});

	it("settles the round, since collecting is what finishing it means", async () => {
		const { run } = await collectRound(
			unsettled(),
			answers({ hawk: { text: said("a") }, owl: { text: said("b") } }),
			recorder(),
		);

		expect(run.open).toBeUndefined();
		expect("open" in run).toBe(false);
	});

	it("anchors against the witness the round recorded", async () => {
		// The reason the witness is written down at all. A finding
		// collected afterwards has to point where it would have
		// pointed live.
		const keeper = recorder();

		await collectRound(
			unsettled({ witness: "abc1234" }),
			answers({ hawk: { text: said("a") } }),
			keeper,
		);

		expect(keeper.kept[0]?.anchor.witness).toBe("abc1234");
	});

	it("anchors against nothing when the round read another tree", async () => {
		// The same rule as a live round, on the path most likely to
		// need it: a round nobody finished is a round whose tree may
		// well have been the caller's checkout. This spread the commit
		// without the caveat beside it and went on stamping anchors
		// with a commit its reviewers never read, which is the whole
		// fault in the one place it survived.
		const keeper = recorder();

		await collectRound(
			unsettled({ witness: "abc1234", unpinned: "read the checkout" }),
			answers({ hawk: { text: said("a") } }),
			keeper,
		);

		expect(keeper.kept).toHaveLength(1);
		expect(keeper.kept[0]?.anchor.witness).toBeUndefined();
	});

	it("says which reviewers left nothing to collect", async () => {
		const { run } = await collectRound(
			unsettled(),
			answers({ hawk: { text: said("a") } }),
			recorder(),
		);

		const owl = run.outcomes.find((o) => o.participantId === "owl");
		expect(owl?.findingIds).toEqual([]);
		expect(owl?.failure).toMatch(/nothing/i);
	});

	it("keeps an outcome the round already had", async () => {
		// A retry can substitute an outcome into an unsettled round
		// before anybody collects it, and that outcome's findings are
		// already in the store. Collecting over it would file them
		// twice.
		const keeper = recorder();

		const { run } = await collectRound(
			unsettled({
				outcomes: [{ participantId: "hawk", findingIds: [7] }],
			}),
			answers({ hawk: { text: said("a") }, owl: { text: said("b") } }),
			keeper,
		);

		expect(run.outcomes.find((o) => o.participantId === "hawk")).toEqual({
			participantId: "hawk",
			findingIds: [7],
		});
		expect(keeper.kept.map((f) => f.subject)).toEqual(["b"]);
	});

	it("holds each outcome as it is filed, not once at the end", async () => {
		// Collecting writes findings against the change and nothing
		// undoes that. Recorded once at the end, a collect that dies
		// halfway leaves findings filed against a round that still says
		// nobody collected it, and the only thing anybody can do with
		// such a round is collect it again.
		const seen: number[] = [];

		await collectRound(
			unsettled(),
			answers({ hawk: { text: said("a") }, owl: { text: said("b") } }),
			{
				...recorder(),
				async progressed(run) {
					seen.push(run.outcomes.length);
				},
			},
		);

		expect(seen).toEqual([1, 2]);
	});

	it("finishes the collect when holding the progress throws", async () => {
		const { run } = await collectRound(
			unsettled(),
			answers({ hawk: { text: said("a") }, owl: { text: said("b") } }),
			{
				...recorder(),
				async progressed() {
					throw new Error("the ledger is on a read-only volume");
				},
			},
		);

		expect(run.outcomes).toHaveLength(2);
	});

	it("leaves the round open when nothing was found for anybody", async () => {
		// The mark is one-way, and the likeliest reason to find nothing
		// is looking in the wrong place: another state directory, or
		// another machine. Settling would close the file on work that is
		// still sitting somewhere.
		const { run, warnings } = await collectRound(
			unsettled(),
			answers({}),
			recorder(),
		);

		expect(run.open).toBe(true);
		expect(warnings.join(" ")).toMatch(/left open/i);
	});

	it("keeps the participants in the order the round asked them", async () => {
		const { run } = await collectRound(
			unsettled(),
			answers({ owl: { text: said("b") }, hawk: { text: said("a") } }),
			recorder(),
		);

		expect(run.outcomes.map((o) => o.participantId)).toEqual(["hawk", "owl"]);
	});
});

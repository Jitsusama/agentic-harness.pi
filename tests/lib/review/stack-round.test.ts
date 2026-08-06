import { describe, expect, it } from "vitest";
import type {
	AskAnswer,
	Finding,
	Roster,
	StackCouncilDeps,
} from "../../../lib/review/index.js";
import {
	runStackCouncil,
	trackAskProgress,
} from "../../../lib/review/index.js";

const stack = ["refs/heads/base", "refs/heads/tip"] as const;

const roster: Roster = {
	reviewers: [
		{ id: "wren", model: "opus" },
		{ id: "finch", model: "sonnet" },
	],
};

const answer = (...findings: unknown[]) => JSON.stringify({ findings });

const one = (over: Record<string, unknown> = {}) => ({
	refs: ["refs/heads/tip"],
	label: "issue",
	subject: "leaks",
	discussion: "the error path",
	location: { kind: "file", file: "lib/a.ts" },
	...over,
});

/** What one participant said, and where each finding was filed. */
interface Spy {
	filed: { ref: string; subjects: string[] }[];
	asked: string[];
}

function deps(
	answers: Record<string, AskAnswer>,
	spy: Spy = { filed: [], asked: [] },
): { deps: StackCouncilDeps; spy: Spy } {
	let next = 1;
	// The first call waits longest, so a round that filed concurrently
	// would land its second reply first and be caught. A fake that
	// yields the same amount every time cannot see the difference: two
	// equal timers fire in registration order, which is the very order
	// the sequential version produces.
	let delay = 6;
	return {
		spy,
		deps: {
			async ask(participant) {
				spy.asked.push(participant.id);
				const held = answers[participant.id];
				if (held === undefined)
					throw new Error(`no answer for ${participant.id}`);
				return held;
			},
			async record(ref, findings) {
				// Claimed synchronously, before the await, or two concurrent
				// callers both read the same delay and the fake is uniform
				// again.
				const wait = delay;
				delay = Math.max(0, delay - 6);
				await new Promise((r) => setTimeout(r, wait));
				spy.filed.push({ ref, subjects: findings.map((f) => f.subject) });
				return findings.map((finding): Finding => ({ ...finding, id: next++ }));
			},
			now: () => new Date("2026-07-30T04:00:00.000Z"),
		},
	};
}

describe("a stack-wide round", () => {
	it("asks every reviewer once", async () => {
		const { deps: d, spy } = deps({
			wren: { text: answer(one()) },
			finch: { text: answer(one()) },
		});

		await runStackCouncil(
			{ roster, prompt: "read the stack", seq: 1, stackRefs: [...stack] },
			d,
		);

		expect(spy.asked.sort()).toEqual(["finch", "wren"]);
	});

	it("files each finding under the change it is said at", async () => {
		const { deps: d, spy } = deps({
			wren: {
				text: answer(
					one({ refs: ["refs/heads/base"], subject: "base thing" }),
					one({ refs: ["refs/heads/tip"], subject: "tip thing" }),
				),
			},
			finch: { text: answer() },
		});

		await runStackCouncil(
			{ roster, prompt: "p", seq: 1, stackRefs: [...stack] },
			d,
		);

		expect(spy.filed).toEqual([
			{ ref: "refs/heads/base", subjects: ["base thing"] },
			{ ref: "refs/heads/tip", subjects: ["tip thing"] },
		]);
	});

	it("files a spanning finding once, at its earliest change", async () => {
		// The whole point of a span. Filing it on both would make a
		// reader answer one observation twice.
		const { deps: d, spy } = deps({
			wren: {
				text: answer(
					one({
						refs: ["refs/heads/tip", "refs/heads/base"],
						subject: "between",
					}),
				),
			},
			finch: { text: answer() },
		});

		await runStackCouncil(
			{ roster, prompt: "p", seq: 1, stackRefs: [...stack] },
			d,
		);

		expect(spy.filed).toEqual([
			{ ref: "refs/heads/base", subjects: ["between"] },
		]);
	});

	it("records in roster order however the answers arrive", async () => {
		// Finch is asked second and answers first. Findings still get
		// numbered wren-then-finch, because people say numbers out loud.
		const spy: Spy = { filed: [], asked: [] };
		const { deps: d } = deps(
			{
				wren: { text: answer(one({ subject: "from wren" })) },
				finch: { text: answer(one({ subject: "from finch" })) },
			},
			spy,
		);
		const slow: StackCouncilDeps = {
			...d,
			async ask(participant, prompt, context) {
				if (participant.id === "wren") {
					await new Promise((r) => setTimeout(r, 5));
				}
				return d.ask(participant, prompt, context);
			},
		};

		const { run } = await runStackCouncil(
			{ roster, prompt: "p", seq: 1, stackRefs: [...stack] },
			slow,
		);

		expect(spy.filed.map((f) => f.subjects[0])).toEqual([
			"from wren",
			"from finch",
		]);
		expect(run.outcomes.map((o) => o.participantId)).toEqual(["wren", "finch"]);
	});

	it("holds every reviewer as a reviewer", async () => {
		const { deps: d } = deps({
			wren: { text: answer() },
			finch: { text: answer() },
		});

		const { run } = await runStackCouncil(
			{ roster, prompt: "p", seq: 1, stackRefs: [...stack] },
			d,
		);

		expect(run.participants.map((p) => p.role)).toEqual([
			"reviewer",
			"reviewer",
		]);
	});

	it("reports its progress, being the longest round there is", async () => {
		// It shipped without this. A stack round reads every change in
		// the stack, so it is the round most likely to look hung, and it
		// was the one round reporting nothing at all.
		const { progress, entries } = trackAskProgress(() => 5_000);
		const { deps: d } = deps({
			wren: {
				text: answer(one({ refs: ["refs/heads/base"], subject: "a" })),
			},
			finch: { text: answer() },
		});

		await runStackCouncil(
			{ roster, prompt: "p", seq: 1, stackRefs: [...stack] },
			{ ...d, progress },
		);

		expect(entries()).toEqual([
			{
				participantId: "wren",
				// Carried so a panel can say which model is answering without
				// being handed the roster a second time.
				model: "opus",
				state: "answered",
				activity: "",
				findings: 1,
				startedAtMs: 5_000,
				settledAtMs: 5_000,
			},
			{
				participantId: "finch",
				model: "sonnet",
				state: "answered",
				activity: "",
				findings: 0,
				startedAtMs: 5_000,
				settledAtMs: 5_000,
			},
		]);
	});

	it("records the round as a stack round", async () => {
		const { deps: d } = deps({
			wren: { text: answer() },
			finch: { text: answer() },
		});

		const { run } = await runStackCouncil(
			{ roster, prompt: "p", seq: 1, stackRefs: [...stack] },
			d,
		);

		expect(run.round).toBe("stack");
		expect(run.id).toMatch(/^stack-/);
	});

	it("keeps the round when one reviewer fails", async () => {
		const { deps: d } = deps({
			wren: { failure: "overloaded" },
			finch: { text: answer(one()) },
		});

		const { run } = await runStackCouncil(
			{ roster, prompt: "p", seq: 1, stackRefs: [...stack] },
			d,
		);

		expect(run.outcomes[0]).toMatchObject({
			participantId: "wren",
			failure: "overloaded",
			findingIds: [],
		});
		expect(run.outcomes[1]?.findingIds).toHaveLength(1);
	});

	it("treats a thrown error as a reported failure", async () => {
		const { deps: d } = deps({ finch: { text: answer() } });

		const { run } = await runStackCouncil(
			{ roster, prompt: "p", seq: 1, stackRefs: [...stack] },
			d,
		);

		expect(run.outcomes[0]?.failure).toContain("no answer for wren");
	});

	it("carries a reviewer's warnings out under its name", async () => {
		const { deps: d } = deps({
			wren: { text: answer(one({ refs: ["refs/heads/ghost"] })) },
			finch: { text: answer() },
		});

		const { warnings } = await runStackCouncil(
			{ roster, prompt: "p", seq: 1, stackRefs: [...stack] },
			d,
		);

		expect(warnings[0]).toContain("wren:");
		expect(warnings[0]).toContain("refs/heads/ghost");
	});

	it("asks for the witness of the change a finding is filed at", async () => {
		const seen: string[] = [];
		const { deps: d } = deps({
			wren: {
				text: answer(
					one({
						refs: ["refs/heads/base"],
						location: { kind: "line", file: "a.ts", start: 3 },
					}),
				),
			},
			finch: { text: answer() },
		});

		await runStackCouncil(
			{
				roster,
				prompt: "p",
				seq: 1,
				stackRefs: [...stack],
				witnessFor: (ref) => {
					seen.push(ref);
					return `sha-${ref}`;
				},
			},
			d,
		);

		expect(seen).toEqual(["refs/heads/base"]);
	});
});

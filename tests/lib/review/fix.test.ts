import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	ChangeRef,
	Finding,
	FixQueue,
} from "../../../lib/review/index.js";
import {
	createFixQueue,
	describeSubject,
	subjectOf,
} from "../../../lib/review/index.js";

const pr: ChangeRef = {
	provider: "github",
	repo: { key: "github:o/r" },
	id: "7",
	label: "o/r#7",
};

const other: ChangeRef = { ...pr, id: "8", label: "o/r#8" };

function finding(id: number, subject = "leaks"): Finding {
	return {
		id,
		anchor: { subject: "line", path: "lib/a.ts", blob: "new", line: 3 },
		label: "issue",
		subject,
		discussion: "the error path returns before the close",
		origin: { kind: "judge", runId: "judge-1", reviewerId: "arbiter" },
	};
}

describe("queueing a fix", () => {
	let root: string;
	let queue: FixQueue;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "fix-queue-"));
		queue = createFixQueue(root);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("has nothing queued for a change nobody has worked on", async () => {
		expect(await queue.next(pr)).toBeUndefined();
		expect(await queue.tally(pr)).toEqual({
			pending: 0,
			committed: 0,
			skipped: 0,
			answered: 0,
		});
	});

	it("hands back what was queued", async () => {
		await queue.queue(pr, finding(1));

		const held = await queue.next(pr);
		expect(held?.findingId).toBe(1);
		expect(held && describeSubject(held)).toBe("leaks");
	});

	it("carries the note the decision was made with", async () => {
		// Whoever queued it knew something about how to fix it. Losing
		// that means the fix is worked out twice.
		await queue.queue(pr, finding(1), "close it in the finally");

		expect((await queue.next(pr))?.note).toBe("close it in the finally");
	});

	it("walks in the order things were queued", async () => {
		// Deterministic, so the same queue read twice is the same queue.
		await queue.queue(pr, finding(1));
		await queue.queue(pr, finding(2));

		expect((await queue.next(pr))?.findingId).toBe(1);
	});

	it("keeps one change's queue out of another's", async () => {
		await queue.queue(pr, finding(1));

		expect(await queue.next(other)).toBeUndefined();
	});

	it("refuses to queue the same finding twice", async () => {
		// A finding queued twice is fixed twice, or worse, fixed once and
		// reported outstanding.
		await queue.queue(pr, finding(1));

		await expect(queue.queue(pr, finding(1))).rejects.toThrow(/already/i);
	});
});

describe("recording what happened", () => {
	let root: string;
	let queue: FixQueue;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "fix-queue-"));
		queue = createFixQueue(root);
		await queue.queue(pr, finding(1));
		await queue.queue(pr, finding(2));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("moves past a fix that landed", async () => {
		await queue.record(pr, 1, { kind: "committed", commit: "abc123" });

		expect((await queue.next(pr))?.findingId).toBe(2);
	});

	it("moves past a fix that was abandoned", async () => {
		await queue.record(pr, 1, { kind: "skipped", reason: "not real" });

		expect((await queue.next(pr))?.findingId).toBe(2);
	});

	it("keeps an abandoned fix in the list with its reason", async () => {
		// Skipped is not deleted. Somebody deciding a finding was wrong is
		// a judgement worth being able to read back.
		await queue.record(pr, 1, { kind: "skipped", reason: "not real" });

		const held = (await queue.list(pr)).find((one) => one.findingId === 1);
		expect(held?.outcome).toEqual({ kind: "skipped", reason: "not real" });
	});

	it("remembers the commit a fix landed in", async () => {
		await queue.record(pr, 1, { kind: "committed", commit: "abc123" });

		const held = (await queue.list(pr)).find((one) => one.findingId === 1);
		expect(held?.outcome).toEqual({ kind: "committed", commit: "abc123" });
	});

	it("counts what is left, done and dropped", async () => {
		await queue.record(pr, 1, { kind: "committed", commit: "abc123" });

		expect(await queue.tally(pr)).toEqual({
			pending: 1,
			committed: 1,
			skipped: 0,
			answered: 0,
		});
	});

	it("says nothing is next once everything is settled", async () => {
		await queue.record(pr, 1, { kind: "committed", commit: "a" });
		await queue.record(pr, 2, { kind: "skipped", reason: "no" });

		expect(await queue.next(pr)).toBeUndefined();
	});

	it("refuses to record against a finding nobody queued", async () => {
		await expect(
			queue.record(pr, 99, { kind: "committed", commit: "a" }),
		).rejects.toThrow(/99/);
	});

	it("refuses to record twice, since the first answer is the true one", async () => {
		await queue.record(pr, 1, { kind: "committed", commit: "a" });

		await expect(
			queue.record(pr, 1, { kind: "skipped", reason: "changed my mind" }),
		).rejects.toThrow(/already/i);
	});
});

describe("across sessions", () => {
	it("reads a queue back from disk", async () => {
		const root = await mkdtemp(join(tmpdir(), "fix-queue-"));
		try {
			await createFixQueue(root).queue(pr, finding(1), "the finally");
			await createFixQueue(root).record(pr, 1, {
				kind: "committed",
				commit: "abc",
			});

			const held = await createFixQueue(root).list(pr);
			expect(held).toHaveLength(1);
			expect(held[0]?.note).toBe("the finally");
			expect(held[0]?.outcome).toEqual({ kind: "committed", commit: "abc" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("somebody's remark on the worklist", () => {
	let root: string;
	let queue: FixQueue;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "fix-queue-"));
		queue = createFixQueue(root);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	const remark = {
		id: "PRRT_abc",
		author: "wren",
		where: "src/a.ts:12",
		said: "this allocates on every frame",
	};

	it("queues a thread and numbers it in the same sequence", async () => {
		await queue.queue(pr, finding(1));

		const id = await queue.queueThread(pr, remark);

		expect(id).toBe(2);
	});

	// One sequence for both kinds, because a person working through a
	// morning's review does not care which half of the surface an item
	// came from, and two schemes make "item 4" ambiguous out loud.
	it("does not collide with a finding queued afterwards", async () => {
		const first = await queue.queueThread(pr, remark);
		await queue.queue(pr, finding(7));

		const ids = (await queue.list(pr)).map((one) => one.findingId);

		expect(first).toBe(1);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("hands it back with who said it and where", async () => {
		await queue.queueThread(pr, remark);

		const held = await queue.next(pr);

		expect(held && describeSubject(held)).toBe(
			"wren on src/a.ts:12: this allocates on every frame",
		);
	});

	it("refuses the same thread twice, naming the item it is already", async () => {
		await queue.queueThread(pr, remark);

		await expect(queue.queueThread(pr, remark)).rejects.toThrow(/item 1/);
	});

	// An answered remark has been dealt with. Recording it as skipped
	// would file it beside the ones nobody got to.
	it("counts an answer apart from a skip", async () => {
		const id = await queue.queueThread(pr, remark);
		await queue.record(pr, id, { kind: "answered", reply: "it is pooled" });

		const tally = await queue.tally(pr);

		expect(tally).toEqual({
			pending: 0,
			committed: 0,
			skipped: 0,
			answered: 1,
		});
	});
});

describe("a queue written before threads could be on it", () => {
	// Adapted on read rather than rewritten on disk. A queue is small,
	// read often and written rarely, so this cannot half-finish the way
	// a migration can.
	it("still reads an entry stored in the old shape", () => {
		const old = { findingId: 3, finding: finding(3) };

		expect(subjectOf(old)).toEqual({ kind: "finding", finding: finding(3) });
		expect(describeSubject(old)).toBe("leaks");
	});

	it("says so rather than throwing when an entry carries neither", () => {
		expect(subjectOf({ findingId: 9 })).toBeUndefined();
		expect(describeSubject({ findingId: 9 })).toContain("nothing recorded");
	});
});

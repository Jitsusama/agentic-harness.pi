import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AskRun, ChangeRef } from "../../../lib/review/index.js";
import { createRunStore } from "../../../lib/review/index.js";

const change: ChangeRef = {
	provider: "github",
	repo: { key: "github:Shopify/world" },
	id: "42",
	label: "Shopify/world#42",
};
const other: ChangeRef = { ...change, id: "43" };

function run(over: Partial<AskRun> = {}): AskRun {
	return {
		id: "council-20260730000000000-000001",
		round: "council",
		startedAt: "2026-07-30T00:00:00.000Z",
		participants: [{ id: "hawk", role: "reviewer" }],
		outcomes: [{ participantId: "hawk", findingIds: [1] }],
		...over,
	};
}

describe("keeping runs per change", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "run-store-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	describe("keeping a round however it got here", () => {
		// A round is now written twice: once when it opens, before it
		// has asked anybody, and once when it settles. Two calls with
		// two meanings would mean deciding at each site which one this
		// is, and getting that wrong either duplicates the round or
		// throws away a finished one.
		it("adds a round it has not seen", async () => {
			const store = createRunStore(root);

			await store.keep(change, run({ outcomes: [], open: true }));

			expect(await store.list(change)).toHaveLength(1);
		});

		it("replaces the one it has, rather than holding both", async () => {
			const store = createRunStore(root);
			await store.keep(change, run({ outcomes: [], open: true }));

			await store.keep(change, run());

			const held = await store.list(change);
			expect(held).toHaveLength(1);
			expect(held[0].open).toBeUndefined();
			expect(held[0].outcomes).toHaveLength(1);
		});

		it("does not offer an unsettled round as the latest of its kind", async () => {
			// A judge asked while a council is still running, or after one
			// was interrupted, would otherwise consolidate the stub's empty
			// outcomes and report that the council found nothing.
			const store = createRunStore(root);
			await store.keep(change, run());
			await store.keep(
				change,
				run({
					id: "council-20260730000000000-000002",
					outcomes: [],
					open: true,
				}),
			);

			expect((await store.latest(change, "council"))?.id).toBe(
				"council-20260730000000000-000001",
			);
		});

		it("says so rather than reporting a torn ledger as a fresh change", async () => {
			// Answering "no rounds" for a file that will not parse is how a
			// history disappears: the caller is told the change is new, and
			// the next write lays one round over the wreckage.
			const store = createRunStore(root);
			await store.keep(change, run());
			const [file] = readdirSync(root);
			writeFileSync(join(root, file), '{"runs": [{"id": "cou');

			await expect(store.list(change)).rejects.toThrow(/could not be read/);
		});

		it("keeps a finished round even when the opening write never landed", async () => {
			// The failure this exists to prevent. The opening write is
			// best-effort, because bookkeeping must not cost a round; if
			// settling were a replace, a failed open would turn the end of
			// a fifteen-minute council into an exception and lose the lot.
			const store = createRunStore(root);

			await store.keep(change, run());

			expect(await store.list(change)).toHaveLength(1);
		});

		it("leaves other changes alone", async () => {
			const store = createRunStore(root);
			await store.keep(other, run());

			await store.keep(change, run());

			expect(await store.list(other)).toHaveLength(1);
			expect(await store.list(change)).toHaveLength(1);
		});
	});

	it("has nothing to report about a change nobody has reviewed", async () => {
		// Absence is an answer, not a failure: a fresh change simply has
		// no rounds behind it.
		expect(await createRunStore(root).list(change)).toEqual([]);
	});

	it("remembers a run and hands it back", async () => {
		const store = createRunStore(root);
		await store.record(change, run());

		expect(await store.list(change)).toEqual([run()]);
	});

	it("keeps every round, not just the last", async () => {
		// A judge consolidates a council, so the council has to still be
		// there afterwards.
		const store = createRunStore(root);
		await store.record(change, run());
		await store.record(change, run({ id: "judge-1", round: "judge" }));

		expect((await store.list(change)).map((r) => r.round)).toEqual([
			"council",
			"judge",
		]);
	});

	it("keeps one change's runs away from another's", async () => {
		const store = createRunStore(root);
		await store.record(change, run());

		expect(await store.list(other)).toEqual([]);
	});

	it("survives a new store over the same directory", async () => {
		// The rounds outlive the session that ran them, which is the
		// whole reason they are on disk.
		await createRunStore(root).record(change, run());

		expect(await createRunStore(root).list(change)).toHaveLength(1);
	});
});

describe("finding the run you mean", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "run-store-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("gives the latest round of a kind", async () => {
		const store = createRunStore(root);
		await store.record(change, run({ id: "council-1" }));
		await store.record(change, run({ id: "council-2" }));

		expect((await store.latest(change, "council"))?.id).toBe("council-2");
	});

	it("ignores rounds of another kind when asked for one", async () => {
		// A judge asked for the latest council must not be handed its own
		// previous run.
		const store = createRunStore(root);
		await store.record(change, run({ id: "council-1" }));
		await store.record(change, run({ id: "judge-1", round: "judge" }));

		expect((await store.latest(change, "council"))?.id).toBe("council-1");
	});

	it("says nothing when no round of that kind has run", async () => {
		const store = createRunStore(root);
		await store.record(change, run());

		expect(await store.latest(change, "critique")).toBeUndefined();
	});

	it("finds a run by its id", async () => {
		const store = createRunStore(root);
		await store.record(change, run({ id: "council-1" }));
		await store.record(change, run({ id: "council-2" }));

		expect((await store.byId(change, "council-1"))?.id).toBe("council-1");
	});

	it("says nothing about an id it never recorded", async () => {
		expect(
			await createRunStore(root).byId(change, "council-nope"),
		).toBeUndefined();
	});
});

describe("replacing a run", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "run-store-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("swaps a run in place, keeping its position", async () => {
		// This is what a retry lands. Appending instead would leave two
		// runs claiming the same id, and every later read would have to
		// guess which was current.
		const store = createRunStore(root);
		await store.record(change, run({ id: "council-1" }));
		await store.record(change, run({ id: "judge-1", round: "judge" }));

		await store.replace(
			change,
			run({
				id: "council-1",
				outcomes: [{ participantId: "hawk", findingIds: [9] }],
			}),
		);

		const held = await store.list(change);
		expect(held).toHaveLength(2);
		expect(held[0]?.outcomes[0]?.findingIds).toEqual([9]);
		expect(held[1]?.id).toBe("judge-1");
	});

	it("names every open round, across every change", async () => {
		// The retention sweep's question, and the only one here that is
		// not about one change. A detached round is finished on disk and
		// open on the ledger, and this is what stops the sweep deleting
		// the answers it is still waiting to be asked for.
		const store = createRunStore(root);
		await store.keep(change, run({ id: "council-open", open: true }));
		await store.keep(change, run({ id: "council-done" }));
		await store.keep(
			{ ...change, id: "999", label: "other#999" },
			run({ id: "council-elsewhere", open: true }),
		);

		expect(await store.openRunIds()).toEqual(
			new Set(["council-open", "council-elsewhere"]),
		);
	});

	it("refuses to replace a run it does not hold", async () => {
		// Silently adding it would make a retry look like it patched
		// something when it invented a run instead.
		const store = createRunStore(root);

		await expect(store.replace(change, run({ id: "ghost" }))).rejects.toThrow(
			/ghost/,
		);
	});
});

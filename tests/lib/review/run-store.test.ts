import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
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

		it("leaves this change's other rounds alone, in the order they ran", async () => {
			// Every other case here holds one round, so a keep that threw
			// away the change's whole history and wrote back the round it
			// was handed passed all of them. The cross-change case below
			// does not catch it either: it is the same change's history
			// that would go, which is the only place a round's findings
			// can be reached from.
			// The round being replaced is deliberately not the last one.
			// Replacing the newest cannot tell an in-place write from a
			// delete-and-append, since both leave the same three ids in
			// the same order, and in place is the claim: a round that
			// jumped to the end of its own change's history would be
			// handed to the next judge as the latest council.
			const store = createRunStore(root);
			await store.keep(change, run({ id: "council-1" }));
			await store.keep(
				change,
				run({ id: "council-2", outcomes: [], open: true }),
			);
			await store.keep(change, run({ id: "judge-1", round: "judge" }));

			await store.keep(change, run({ id: "council-2" }));

			const held = await store.list(change);
			expect(held.map((one) => one.id)).toEqual([
				"council-1",
				"council-2",
				"judge-1",
			]);
			// And it is the settled version sitting where the stub sat,
			// not a fresh entry after the judge that came later.
			expect(held[1]?.open).toBeUndefined();
			expect(held[1]?.outcomes).toHaveLength(1);
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

		expect(await store.openRunIds()).toEqual({
			open: new Set(["council-open", "council-elsewhere"]),
			unreadable: [],
		});
	});

	it("refuses a change whose ledger is there and will not open", async () => {
		// The same errno confusion as the sweep's, and worse here. A file
		// that cannot be opened is not a change with no history, and
		// answering "no rounds" means the next round written lays a
		// one-round ledger over everything behind it.
		const store = createRunStore(root);
		await store.keep(change, run({ id: "council-one" }));
		const [held] = readdirSync(root);
		await chmod(join(root, held), 0o000);

		try {
			await expect(store.list(change)).rejects.toThrow(/could not be read/);
		} finally {
			await chmod(join(root, held), 0o600);
		}
	});

	it("reads a change nobody has ever reviewed as having no rounds", async () => {
		// The other half, and the reason the errno has to be looked at
		// rather than every failure being treated the same: most changes
		// have no file at all, and that is an answer.
		expect(await createRunStore(root).list(change)).toEqual([]);
	});

	it("names a ledger file it could not ask, rather than passing over it", async () => {
		// The sweep reads this to decide what it may delete, and a file it
		// skipped is a change whose open rounds are missing from the
		// answer with nothing saying so. Those rounds are detached ones
		// that finished on disk, so nothing protecting them means the
		// ordinary window takes findings nobody has read yet.
		//
		// Skipping was justified on the grounds that a sweep errs towards
		// deleting nothing it is unsure about. It does not: a run nothing
		// protects is a run on the ordinary window.
		const store = createRunStore(root);
		await store.keep(change, run({ id: "council-open", open: true }));
		await writeFile(join(root, "torn.json"), "{ not json", "utf8");
		await writeFile(join(root, "wrong-shape.json"), '{"rounds":[]}', "utf8");

		const { open, unreadable } = await store.openRunIds();

		// What could be read is still read: one bad file is not a reason
		// to answer nothing about twenty good ones.
		expect(open).toEqual(new Set(["council-open"]));
		// Full paths, since a caller that declines to sweep over this has
		// to tell somebody which file to deal with, and a bare name does
		// not locate one under a state directory nobody has memorized.
		expect([...unreadable].sort()).toEqual([
			join(root, "torn.json"),
			join(root, "wrong-shape.json"),
		]);
	});

	it("tells a missing ledger from one it cannot get into", async () => {
		// Absence is an answer: most changes have never been reviewed, so
		// no directory means no open rounds. Every other errno means the
		// history is there and cannot be seen, and answering "none" to
		// those tells the sweep every round on disk is collectable
		// rubbish. The catch used to be untyped and made no distinction.
		expect(
			await createRunStore(join(root, "nothing-here")).openRunIds(),
		).toEqual({ open: new Set(), unreadable: [] });

		const shut = join(root, "shut");
		await mkdir(shut);
		await chmod(shut, 0o000);
		try {
			const { open, unreadable } = await createRunStore(shut).openRunIds();

			expect(open).toEqual(new Set());
			// Naming the directory as a directory. The rest of this list is
			// file names, and a bare path dropped among them reads as one
			// more torn file rather than as the whole history being shut.
			expect(unreadable).toHaveLength(1);
			expect(unreadable[0]).toContain(shut);
			expect(unreadable[0]).toContain("the whole ledger");
		} finally {
			await chmod(shut, 0o700);
		}
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

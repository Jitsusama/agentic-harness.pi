/**
 * A fleet is written down, so one can be found after its session is
 * gone.
 *
 * The reason is the reason the review side has a ledger, arrived at
 * the same way and one layer down. A fleet's answers exist in exactly
 * two places: the tool result handed back to the session that asked,
 * and the transcripts on disk. When the session dies mid-fleet the
 * first never happens, and nothing records that the second is worth
 * keeping, so the retention sweep takes it on the ordinary window.
 * The work was paid for and nobody ever reads it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFleetLedger } from "../../../lib/subagent/fleet.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fleet-ledger-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A fleet as the tool dispatches one. */
function fleet(id: string, jobs: string[] = ["one", "two"]) {
	return { id, startedAt: new Date().toISOString(), jobs };
}

describe("a fleet ledger", () => {
	it("holds a fleet from before it is dispatched", async () => {
		// Before, not after. A fleet recorded when it finishes is a
		// fleet that is recorded exactly when nothing needed it to be:
		// the whole population this exists for is the fleets that never
		// reached their own ending.
		const ledger = createFleetLedger(root);

		await ledger.open(fleet("fleet-a"));

		expect(await ledger.list()).toEqual([
			expect.objectContaining({ id: "fleet-a", open: true }),
		]);
	});

	it("marks a fleet settled without forgetting it", async () => {
		// Kept rather than deleted, because the transcripts outlive the
		// answer and somebody reading a summary a day later still needs
		// to be able to find what a job actually said.
		const ledger = createFleetLedger(root);
		await ledger.open(fleet("fleet-a"));

		await ledger.settle("fleet-a");

		const held = await ledger.list();
		expect(held).toHaveLength(1);
		expect(held[0]?.open).toBeUndefined();
		expect(held[0]?.settledAt).toEqual(expect.any(String));
	});

	it("names every fleet nothing has read yet", async () => {
		// What the sweep is told. A settled fleet has been handed back
		// to whoever asked for it, so its transcripts are a
		// convenience; an open one is the only copy there is.
		const ledger = createFleetLedger(root);
		await ledger.open(fleet("fleet-open"));
		await ledger.open(fleet("fleet-done"));
		await ledger.settle("fleet-done");

		const { open, unreadable } = await ledger.openFleets();

		expect(open).toEqual(new Set(["fleet-open"]));
		expect(unreadable).toEqual([]);
	});

	it("names a file it could not read rather than passing over it", async () => {
		// The lesson the review ledger paid for. A torn file read as
		// "no open fleets" is not the cautious answer, it is the
		// destructive one: the sweep is then told nothing needs keeping
		// and deletes exactly the work this protects.
		const ledger = createFleetLedger(root);
		await ledger.open(fleet("fleet-open"));
		writeFileSync(join(root, "torn.json"), "{ not json", "utf8");

		const { open, unreadable } = await ledger.openFleets();

		expect(open).toEqual(new Set(["fleet-open"]));
		expect(unreadable).toEqual([join(root, "torn.json")]);
	});

	it("answers an empty ledger without making one", async () => {
		// Read on every session start, including the overwhelming
		// majority that never dispatch a fleet at all. Creating a
		// directory to discover it is empty is a write on a read path.
		const ledger = createFleetLedger(join(root, "not-yet"));

		expect(await ledger.list()).toEqual([]);
		expect((await ledger.openFleets()).open).toEqual(new Set());
		expect(await readdir(root)).toEqual([]);
	});

	it("keeps a fleet whose id is nothing like a filename", async () => {
		// Ids arrive from a caller. One with a slash in it would write
		// outside the ledger, or fail, and the run it belonged to would
		// go unprotected either way.
		const ledger = createFleetLedger(root);

		await ledger.open(fleet("../../etc/fleet a"));

		expect((await ledger.openFleets()).open).toEqual(
			new Set(["../../etc/fleet a"]),
		);
		const files = await readdir(root);
		expect(files).toHaveLength(1);
		expect(files[0]).not.toContain("/");
	});

	it("settles a fleet it has never heard of without inventing one", async () => {
		// A settle whose open write failed, which is the ordering this
		// uses on purpose: recording a fleet must never cost the fleet,
		// so the open write is best effort. Writing a settled record
		// here would put a fleet on the ledger that nothing protected
		// while it ran, which reads as evidence that it was safe.
		const ledger = createFleetLedger(root);

		await ledger.settle("never-opened");

		expect(await ledger.list()).toEqual([]);
	});

	it("survives two fleets settling at once", async () => {
		// One file per fleet rather than one file holding all of them.
		// Two sessions running fleets at the same time is ordinary, and
		// a read-modify-write over a shared file loses one of them.
		const ledger = createFleetLedger(root);
		await ledger.open(fleet("fleet-a"));
		await ledger.open(fleet("fleet-b"));

		await Promise.all([ledger.settle("fleet-a"), ledger.settle("fleet-b")]);

		expect((await ledger.openFleets()).open).toEqual(new Set());
		expect(await ledger.list()).toHaveLength(2);
	});

	it("passes over anything that is not a ledger file", async () => {
		// The directory is somebody's state directory and will collect
		// editor droppings and half-written temporary files.
		const ledger = createFleetLedger(root);
		await ledger.open(fleet("fleet-a"));
		mkdirSync(join(root, "a-directory"));
		writeFileSync(join(root, "notes.txt"), "not a ledger", "utf8");

		expect(await ledger.list()).toHaveLength(1);
		expect((await ledger.openFleets()).unreadable).toEqual([]);
	});
});

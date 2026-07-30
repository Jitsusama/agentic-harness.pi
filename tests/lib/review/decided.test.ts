/**
 * A finding already dealt with should not read like a fresh one.
 */

import { readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ChangeRef,
	createDecisionLedger,
} from "../../../lib/review/index.js";

const change: ChangeRef = {
	provider: "github",
	repo: { key: "github:acme/widget" },
	id: "41",
	label: "acme/widget#41",
};

const other: ChangeRef = {
	provider: "github",
	repo: { key: "github:acme/widget" },
	id: "42",
	label: "acme/widget#42",
};

/** Every JSON file the ledger has written under `dir`. */
function ledgerFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...ledgerFiles(path));
		else if (entry.name.endsWith(".json")) found.push(path);
	}
	return found;
}

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "review-decided-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("the decision ledger", () => {
	it("knows nothing about a change nobody has decided on", async () => {
		const ledger = createDecisionLedger(root);

		expect(await ledger.list(change)).toEqual([]);
	});

	it("keeps a verdict and what was said with it", async () => {
		const ledger = createDecisionLedger(root);

		await ledger.record(change, 3, "promote", "said in my own words");

		expect(await ledger.list(change)).toMatchObject([
			{ findingId: 3, verdict: "promote", note: "said in my own words" },
		]);
	});

	it("keeps a verdict with nothing said", async () => {
		const ledger = createDecisionLedger(root);

		await ledger.record(change, 3, "dismiss");
		const [only] = await ledger.list(change);

		expect(only?.verdict).toBe("dismiss");
		expect(only).not.toHaveProperty("note");
	});

	it("records when it was decided", async () => {
		const ledger = createDecisionLedger(root);

		await ledger.record(change, 1, "fix");
		const [only] = await ledger.list(change);

		expect(only?.decidedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
	});

	it("lets somebody change their mind", async () => {
		// Ordinary, and the opposite of a fix outcome, which refuses a
		// second recording because the work either landed or did not.
		const ledger = createDecisionLedger(root);

		await ledger.record(change, 3, "promote");
		await ledger.record(change, 3, "dismiss", "on reflection, no");

		expect(await ledger.list(change)).toMatchObject([
			{ findingId: 3, verdict: "dismiss", note: "on reflection, no" },
		]);
	});

	it("keeps a re-decided finding in its original position", async () => {
		// Or the listing reshuffles every time somebody reconsiders, and
		// a reader loses their place.
		const ledger = createDecisionLedger(root);

		await ledger.record(change, 1, "promote");
		await ledger.record(change, 2, "promote");
		await ledger.record(change, 1, "dismiss");

		expect((await ledger.list(change)).map((one) => one.findingId)).toEqual([
			1, 2,
		]);
	});

	it("keeps one change's decisions out of another's", async () => {
		const ledger = createDecisionLedger(root);

		await ledger.record(change, 1, "promote");
		await ledger.record(other, 9, "dismiss");

		expect(await ledger.list(change)).toHaveLength(1);
		expect((await ledger.list(other))[0]?.findingId).toBe(9);
	});

	it("survives a ledger that is not readable JSON", async () => {
		// The record is an aid to a reader, so a corrupt one must not
		// take down the listing it decorates.
		const ledger = createDecisionLedger(root);
		await ledger.record(change, 1, "promote");
		// A change key carries a directory component, so the ledger nests
		// rather than sitting flat in the root.
		const written = ledgerFiles(root);
		expect(written, "expected the ledger to have written a file").toHaveLength(
			1,
		);
		await writeFile(written[0] as string, "{ not json", "utf8");

		expect(await ledger.list(change)).toEqual([]);
	});

	it("survives being read across two ledger handles", async () => {
		// Nothing is cached in the handle: a second session must see what
		// the first decided.
		await createDecisionLedger(root).record(change, 7, "fix");

		expect(await createDecisionLedger(root).list(change)).toMatchObject([
			{ findingId: 7, verdict: "fix" },
		]);
	});
});

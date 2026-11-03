/**
 * A judge, critique or retry reads the round it was given, not the
 * latest one, when a change holds several.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { roundToRead } from "../../extensions/review-integration/round-to-read.ts";
import type { AskRun, ChangeRef } from "../../lib/core/review/index.ts";
import { createRunStore } from "../../lib/core/review/index.ts";

const change: ChangeRef = {
	provider: "github",
	repo: { key: "github:shop/world" },
	id: "2350871",
	label: "shop/world#2350871",
};

const AGENT = "council-20261103T112140487-000001";
const AQUIFERADM = "council-20261103T112138997-000001";

function council(id: string, over: Partial<AskRun> = {}): AskRun {
	return {
		id,
		round: "council",
		startedAt: "2026-11-03T11:21:00.000Z",
		participants: [{ id: "hawk", role: "reviewer" }],
		outcomes: [{ participantId: "hawk", findingIds: [1] }],
		...over,
	};
}

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "round-to-read-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("choosing the round another round reads", () => {
	it("reads the council named, though another finished after it", async () => {
		const store = createRunStore(root);
		await store.keep(change, council(AQUIFERADM));
		await store.keep(change, council(AGENT));

		const chosen = await roundToRead(store, change, "council", AQUIFERADM);

		expect(chosen).toEqual({
			run: expect.objectContaining({ id: AQUIFERADM }),
		});
	});

	it("reads the latest finished council when none is named", async () => {
		const store = createRunStore(root);
		await store.keep(change, council(AQUIFERADM));
		await store.keep(change, council(AGENT));

		const chosen = await roundToRead(store, change, "council");

		expect(chosen).toEqual({ run: expect.objectContaining({ id: AGENT }) });
	});

	it("says there is none when nothing of that kind has finished", async () => {
		const store = createRunStore(root);

		expect(await roundToRead(store, change, "council")).toEqual({ none: true });
	});

	it("refuses an id it never recorded, naming the councils it could read", async () => {
		const store = createRunStore(root);
		await store.keep(change, council(AGENT));

		const chosen = await roundToRead(store, change, "council", "council-x");

		expect(chosen).toEqual({
			refusal: `No round "council-x" is held against shop/world#2350871. Finished: ${AGENT}.`,
		});
	});

	it("refuses a round of another kind than the one it reads", async () => {
		const store = createRunStore(root);
		await store.keep(change, council(AGENT));

		const chosen = await roundToRead(store, change, "judge", AGENT);

		expect(chosen).toEqual({
			refusal: `${AGENT} is a council, not a judge. No judge has finished on shop/world#2350871.`,
		});
	});

	it("refuses a council still open rather than reading its empty answers", async () => {
		const store = createRunStore(root);
		await store.keep(change, council(AGENT));
		await store.keep(change, council(AQUIFERADM, { outcomes: [], open: true }));

		const chosen = await roundToRead(store, change, "council", AQUIFERADM);

		expect(chosen).toEqual({
			refusal: `${AQUIFERADM} has not been collected, so it has nothing finished to read. Finished: ${AGENT}.`,
		});
	});
});

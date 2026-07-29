import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addFinding,
	createDraftStore,
	type DraftStore,
	emptyDraft,
	type LineAnchor,
	type ReviewTarget,
	setVerdict,
} from "../../../lib/review";

const hosted: ReviewTarget = {
	kind: "proposal",
	change: {
		provider: "meteorite",
		repo: { key: "gitstream:shop/world" },
		id: "2000970",
		label: "shop/world#2000970",
	},
};

const other: ReviewTarget = {
	kind: "range",
	repo: { key: "local:/src/app" },
	base: "main",
	head: "topic",
};

const anchor: LineAnchor = {
	subject: "line",
	path: "lib/app.ts",
	blob: "new",
	line: 3,
};

let root: string;
let store: DraftStore;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "review-drafts-"));
	store = createDraftStore(root);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("the draft store", () => {
	it("has nothing in it to begin with", async () => {
		expect(await store.list()).toEqual([]);
	});

	it("finds nothing when asked for a draft that was never saved", async () => {
		expect(await store.load("nope")).toBeUndefined();
	});

	it("saves a draft and reads it back whole", async () => {
		const state = addFinding(emptyDraft("d1", hosted), {
			anchor,
			body: "leaks",
		});
		await store.save(state);
		expect(await store.load("d1")).toEqual(state);
	});

	it("creates the directory it was pointed at", async () => {
		const nested = createDraftStore(join(root, "deep", "deeper"));
		await nested.save(emptyDraft("d1", hosted));
		expect(await nested.load("d1")).toBeTruthy();
	});

	it("overwrites a draft saved again under the same id", async () => {
		await store.save(emptyDraft("d1", hosted));
		await store.save(setVerdict(emptyDraft("d1", hosted), "approve", "fine"));
		const loaded = await store.load("d1");
		expect(loaded?.verdict).toBe("approve");
		expect(await store.list()).toHaveLength(1);
	});

	it("summarizes what is in flight without loading every draft", async () => {
		let state = addFinding(emptyDraft("d1", hosted), { anchor, body: "one" });
		state = setVerdict(state, "request-changes", "look here");
		await store.save(state);
		const [summary] = await store.list();
		expect(summary.id).toBe("d1");
		expect(summary.itemCount).toBe(1);
		expect(summary.verdict).toBe("request-changes");
		expect(summary.target).toEqual(hosted);
		expect(summary.updatedAt).toBe(state.updatedAt);
	});

	it("lists the most recently touched draft first", async () => {
		await store.save({
			...emptyDraft("older", hosted),
			updatedAt: "2026-07-01T00:00:00.000Z",
		});
		await store.save({
			...emptyDraft("newer", hosted),
			updatedAt: "2026-07-28T00:00:00.000Z",
		});
		expect((await store.list()).map((entry) => entry.id)).toEqual([
			"newer",
			"older",
		]);
	});

	it("finds the drafts about one target and no others", async () => {
		await store.save(emptyDraft("here", hosted));
		await store.save(emptyDraft("elsewhere", other));
		const found = await store.forTarget(hosted);
		expect(found.map((entry) => entry.id)).toEqual(["here"]);
	});

	it("removes a draft", async () => {
		await store.save(emptyDraft("d1", hosted));
		await store.remove("d1");
		expect(await store.load("d1")).toBeUndefined();
		expect(await store.list()).toEqual([]);
	});

	it("shrugs at removing something that is not there", async () => {
		await expect(store.remove("ghost")).resolves.toBeUndefined();
	});

	it("ignores a file in its directory that is not a draft", async () => {
		await store.save(emptyDraft("d1", hosted));
		await writeFile(join(root, "notes.txt"), "not a draft", "utf8");
		await writeFile(join(root, "broken.json"), "{ oops", "utf8");
		expect((await store.list()).map((entry) => entry.id)).toEqual(["d1"]);
	});

	it("keeps a draft id out of the path it writes", async () => {
		await store.save(emptyDraft("../escape", hosted));
		const entries = await readdir(root);
		expect(entries.every((entry) => entry.endsWith(".json"))).toBe(true);
		expect(await store.load("../escape")).toBeTruthy();
	});
});

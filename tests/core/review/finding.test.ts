import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Anchor } from "../../../lib/core/review/anchor.ts";
import type { ChangeRef } from "../../../lib/core/review/change.ts";
import {
	byRoundNewestFirst,
	createFindingStore,
	type Finding,
	type FindingStore,
} from "../../../lib/core/review/finding.ts";

describe("a change's findings by round", () => {
	const raised = (id: number, origin: Finding["origin"]): Finding => ({
		id,
		anchor: { subject: "change" } as Anchor,
		label: "issue",
		subject: `finding ${id}`,
		discussion: "",
		origin,
	});
	const reviewer = (runId: string) => ({
		kind: "reviewer" as const,
		runId,
		reviewerId: "a",
	});

	it("puts the newest round first, by its newest finding, whatever its run is called", () => {
		const rounds = byRoundNewestFirst([
			raised(1, reviewer("council-20261026T154044")),
			raised(2, { kind: "judge", runId: "judge-x", reviewerId: "j" }),
			raised(3, { kind: "hand" }),
			raised(5, reviewer("council-20261029T170328")),
			raised(4, reviewer("council-20261029T170328")),
		]);

		expect(rounds.map((round) => round.runId)).toEqual([
			"council-20261029T170328",
			undefined,
			"judge-x",
			"council-20261026T154044",
		]);
		expect(rounds[0]?.findings.map((finding) => finding.id)).toEqual([4, 5]);
	});

	it("holds nothing for a change nobody has reviewed", () => {
		expect(byRoundNewestFirst([])).toEqual([]);
	});
});

function change(label: string): ChangeRef {
	return {
		provider: "github",
		repo: { key: "github:Shopify/world" },
		id: label,
		label,
	};
}

function at(path: string, line: number, witness?: string): Anchor {
	return witness === undefined
		? { subject: "line", path, blob: "new", line }
		: { subject: "line", path, blob: "new", line, witness };
}

function raised(
	subject: string,
	anchor: Anchor = at("lib/a.ts", 1),
): Omit<Finding, "id"> {
	return {
		anchor,
		label: "issue",
		subject,
		discussion: "because it does the wrong thing",
		origin: { kind: "reviewer", runId: "r1", reviewerId: "security" },
	};
}

describe("createFindingStore", () => {
	let root: string;
	let store: FindingStore;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "finding-store-"));
		store = createFindingStore(root);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("holds no findings for a change nobody has reviewed", async () => {
		expect(await store.list(change("Shopify/world#1"))).toEqual([]);
	});

	it("reads a recorded finding back whole", async () => {
		const pr = change("Shopify/world#1");

		await store.record(pr, [raised("the lock is never released")]);

		const [found] = await store.list(pr);
		expect(found?.subject).toBe("the lock is never released");
		expect(found?.origin).toEqual({
			kind: "reviewer",
			runId: "r1",
			reviewerId: "security",
		});
	});

	it("numbers findings from one, in the order they were raised", async () => {
		const pr = change("Shopify/world#1");

		const recorded = await store.record(pr, [
			raised("first"),
			raised("second"),
			raised("third"),
		]);

		expect(recorded.map((f) => f.id)).toEqual([1, 2, 3]);
	});

	it("keeps climbing rather than reusing a number a person may have said", async () => {
		const pr = change("Shopify/world#1");
		await store.record(pr, [raised("first"), raised("second")]);

		const later = await store.record(pr, [raised("third")]);

		expect(later.map((f) => f.id)).toEqual([3]);
		expect((await store.list(pr)).map((f) => f.id)).toEqual([1, 2, 3]);
	});

	it("does not reuse numbers even after everything is cleared", async () => {
		const pr = change("Shopify/world#1");
		await store.record(pr, [raised("first"), raised("second")]);

		await store.clear(pr);
		const afterClear = await store.record(pr, [raised("fresh")]);

		expect(await store.list(pr)).toHaveLength(1);
		expect(afterClear[0]?.id).toBe(3);
	});

	it("keeps each change's findings to itself", async () => {
		const one = change("Shopify/world#1");
		const two = change("Shopify/world#2");

		await store.record(one, [raised("on one")]);
		await store.record(two, [raised("on two")]);

		expect((await store.list(one)).map((f) => f.subject)).toEqual(["on one"]);
		expect((await store.list(two)).map((f) => f.subject)).toEqual(["on two"]);
	});

	it("carries the anchor through, witness and all", async () => {
		const pr = change("Shopify/world#1");

		await store.record(pr, [
			raised("stale soon", at("lib/b.ts", 12, "abc123")),
		]);

		const [found] = await store.list(pr);
		expect(found?.anchor).toEqual({
			subject: "line",
			path: "lib/b.ts",
			blob: "new",
			line: 12,
			witness: "abc123",
		});
	});

	it("survives being opened again, since a council run outlives one call", async () => {
		const pr = change("Shopify/world#1");
		await store.record(pr, [raised("persisted")]);

		const reopened = createFindingStore(root);

		expect((await reopened.list(pr)).map((f) => f.subject)).toEqual([
			"persisted",
		]);
	});

	it("keeps a label a change's path could not hold", async () => {
		const pr = change("Shopify/world#1?../../etc");

		await store.record(pr, [raised("awkward")]);

		expect((await store.list(pr)).map((f) => f.subject)).toEqual(["awkward"]);
	});
});

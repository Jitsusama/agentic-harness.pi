import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AttachmentStore,
	createAttachmentStore,
} from "../../../lib/review/attach.js";
import type { ChangeRef } from "../../../lib/review/change.js";

function change(label: string, id = label): ChangeRef {
	return {
		provider: "github",
		repo: { key: "github:Shopify/world" },
		id,
		label,
	};
}

describe("createAttachmentStore", () => {
	let root: string;
	let store: AttachmentStore;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "attach-store-"));
		store = createAttachmentStore(root);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("has nothing attached to begin with", async () => {
		expect(await store.list()).toEqual([]);
	});

	it("reads an attached change back whole", async () => {
		await store.attach(change("Shopify/world#1"));

		const attached = await store.list();

		expect(attached).toHaveLength(1);
		expect(attached[0]?.change).toEqual(change("Shopify/world#1"));
		expect(attached[0]?.attachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("survives a restart, because a fresh store reads the same disk", async () => {
		await store.attach(change("Shopify/world#1"));

		const reopened = createAttachmentStore(root);

		expect(await reopened.list()).toHaveLength(1);
	});

	it("lists the most recently attached change first", async () => {
		await store.attach(change("Shopify/world#1"));
		await store.attach(change("Shopify/world#2"));

		const labels = (await store.list()).map((a) => a.change.label);

		expect(labels).toEqual(["Shopify/world#2", "Shopify/world#1"]);
	});

	it("does not duplicate a change attached twice", async () => {
		await store.attach(change("Shopify/world#1"));
		await store.attach(change("Shopify/world#1"));

		expect(await store.list()).toHaveLength(1);
	});

	it("detaches a change by label and says it did", async () => {
		await store.attach(change("Shopify/world#1"));

		expect(await store.detach("Shopify/world#1")).toBe(true);
		expect(await store.list()).toEqual([]);
	});

	it("reports detaching something that was never attached", async () => {
		expect(await store.detach("Shopify/world#9")).toBe(false);
	});

	it("keeps changes whose labels differ only by characters a path cannot hold", async () => {
		await store.attach(change("shop/world!2000970", "a"));
		await store.attach(change("shop/world#2000970", "b"));

		expect(await store.list()).toHaveLength(2);
	});
});

import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AttachmentStore,
	createAttachmentStore,
	pruneAttachments,
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

describe("attachments belong to the session that made them", () => {
	// Measured, not imagined. A council round in one session was
	// retargeted mid-flight by another session attaching its own work:
	// the judge that followed consolidated a different repository's
	// council, and the findings read back belonged to a third change.
	// Every call reported success. The store is shared by every session
	// on the machine, while the thing it models, what I am working on
	// now, belongs to one.
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "attach-sessions-"));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("does not show one session what another attached", async () => {
		const mine = createAttachmentStore(root, "session-a");
		const theirs = createAttachmentStore(root, "session-b");

		await mine.attach(change("Jitsusama/agentic-harness.pi#447"));
		await theirs.attach(change("shop/world#976478"));

		expect((await mine.list()).map((a) => a.change.label)).toEqual([
			"Jitsusama/agentic-harness.pi#447",
		]);
		expect((await theirs.list()).map((a) => a.change.label)).toEqual([
			"shop/world#976478",
		]);
	});

	it("keeps two sessions attached to the same change apart", async () => {
		// Two sessions reviewing one change is ordinary, and detaching in
		// one must not detach in the other.
		const mine = createAttachmentStore(root, "session-a");
		const theirs = createAttachmentStore(root, "session-b");
		await mine.attach(change("shop/world#1"));
		await theirs.attach(change("shop/world#1"));

		expect(await theirs.detach("shop/world#1")).toBe(true);

		expect((await mine.list()).map((a) => a.change.label)).toEqual([
			"shop/world#1",
		]);
		expect(await theirs.list()).toEqual([]);
	});

	it("will not detach a change another session attached", async () => {
		const mine = createAttachmentStore(root, "session-a");
		const theirs = createAttachmentStore(root, "session-b");
		await theirs.attach(change("shop/world#2"));

		expect(await mine.detach("shop/world#2")).toBe(false);
		expect((await theirs.list()).map((a) => a.change.label)).toEqual([
			"shop/world#2",
		]);
	});

	it("ignores what a session before it left behind", async () => {
		// Attachments from earlier sessions are on disk already, and
		// inheriting them is the same bug wearing a hat: a fresh session
		// would act on whatever the last one happened to leave.
		await createAttachmentStore(root, "session-old").attach(
			change("shop/world#3"),
		);

		expect(await createAttachmentStore(root, "session-new").list()).toEqual([]);
	});
});

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

describe("a session's directory does not outlive its usefulness", () => {
	// Scoping per session means one directory per session, forever,
	// unless something takes them back. This extension already decided
	// that state accumulating per run needs a retention policy; the
	// same reasoning applies to state accumulating per session.
	let root: string;
	const DAY = 24 * 60 * 60 * 1000;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "attach-prune-"));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	/** A session that last attached something this long ago. */
	async function sessionAged(id: string, ageMs: number): Promise<void> {
		await createAttachmentStore(root, id).attach(change(`x#${id}`));
		const when = new Date(Date.now() - ageMs);
		await utimes(join(root, id), when, when);
	}

	it("gives back a directory nothing has touched in a long time", async () => {
		await sessionAged("long-gone", 40 * DAY);
		await sessionAged("yesterday", 1 * DAY);

		const taken = await pruneAttachments(root, { olderThanMs: 30 * DAY });

		expect(taken).toBe(1);
		expect(await readdir(root)).toEqual(["yesterday"]);
	});

	it("never takes the caller's own, however it looks", async () => {
		// A long-lived session is the one most worth keeping and the one
		// an mtime rule is most likely to condemn, since it attached its
		// work once and has been reading it ever since.
		await sessionAged("mine", 90 * DAY);

		const taken = await pruneAttachments(root, {
			olderThanMs: 30 * DAY,
			keep: "mine",
		});

		expect(taken).toBe(0);
		expect(await readdir(root)).toEqual(["mine"]);
	});

	it("leaves what it does not understand alone", async () => {
		// Everything attached before scoping existed sits flat in the
		// root. It belongs to no session, so no session's rule should
		// decide its fate, and deleting somebody's attachment to tidy up
		// is a poor trade for the disk it returns.
		await createAttachmentStore(root).attach(change("from/before#1"));

		const taken = await pruneAttachments(root, { olderThanMs: 0 });

		expect(taken).toBe(0);
		expect((await readdir(root)).length).toBe(1);
	});
});

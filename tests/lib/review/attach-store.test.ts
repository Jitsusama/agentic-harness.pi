import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AttachmentStore,
	createAttachmentStore,
	inheritAttachments,
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
		store = createAttachmentStore(root, "one-session");
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

		const reopened = createAttachmentStore(root, "one-session");

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

describe("a fork keeps what the session it came from was working on", () => {
	// A fork is the same work continued, and pi mints it a new session
	// id. Scoping attachments by session therefore made a fork start
	// with nothing attached, so the first review call after one either
	// refused for want of a change or acted on whatever the person
	// happened to name. Neither is what forking means.
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "attach-fork-"));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("carries the parent's attachments into the fork", async () => {
		const parent = createAttachmentStore(root, "session-a");
		await parent.attach(change("world#1"));
		await parent.attach(change("world#2"));

		const carried = await inheritAttachments(root, "session-a", "session-b");

		const fork = createAttachmentStore(root, "session-b");
		expect(carried).toBe(2);
		expect((await fork.list()).map((one) => one.change.label)).toEqual([
			"world#2",
			"world#1",
		]);
	});

	it("leaves the parent holding its own", async () => {
		// A fork is a copy, not a move. The session forked from is still
		// there and still working on what it was working on.
		const parent = createAttachmentStore(root, "session-a");
		await parent.attach(change("world#1"));

		await inheritAttachments(root, "session-a", "session-b");

		expect((await parent.list()).map((one) => one.change.label)).toEqual([
			"world#1",
		]);
	});

	it("never re-attaches a change the fork already holds", async () => {
		// Inheriting runs at session start, and a session that has
		// already said what it is working on has said something the
		// parent cannot know better. Re-attaching is visible in the
		// order, since attaching numbers a change above everything
		// else: it would lift the change this session attached first
		// above the one it attached second. The parent holds a change
		// the fork does not, so the loop reaches a write either way and
		// the case cannot pass by returning early.
		const parent = createAttachmentStore(root, "session-a");
		await parent.attach(change("world#1"));
		await parent.attach(change("world#3"));
		const fork = createAttachmentStore(root, "session-b");
		await fork.attach(change("world#1"));
		await fork.attach(change("world#2"));

		const carried = await inheritAttachments(root, "session-a", "session-b");

		// The fork's own two on top, in the order it made them, and the
		// one change it did not already hold underneath both.
		expect(carried).toBe(1);
		expect((await fork.list()).map((one) => one.change.label)).toEqual([
			"world#2",
			"world#1",
			"world#3",
		]);
	});

	it("carries nothing when the parent had nothing", async () => {
		// The common case, and it must not be an error: most sessions
		// attach nothing at all.
		const carried = await inheritAttachments(root, "never-existed", "fork");

		expect(carried).toBe(0);
	});

	it("will not copy a session onto itself", async () => {
		// Reading and writing the same directory, where every name
		// collides with itself, is a way to lose an attachment rather
		// than a way to keep one.
		const mine = createAttachmentStore(root, "session-a");
		await mine.attach(change("world#1"));

		const carried = await inheritAttachments(root, "session-a", "session-a");

		expect(carried).toBe(0);
		expect(await mine.list()).toHaveLength(1);
	});

	it("keeps everything it inherited below what the fork said itself", async () => {
		// The order attachments were made in is what picks the change a
		// call acts on when it names none, and it is announced as the
		// one attached most recently. So an inherited change ranking
		// above what this session just said it was working on would act
		// on the parent's work and call it the newest, which is false
		// twice over. The parent's own order survives underneath.
		const parent = createAttachmentStore(root, "session-a");
		await parent.attach(change("older"));
		await parent.attach(change("newer"));
		const fork = createAttachmentStore(root, "session-b");
		await fork.attach(change("said just now"));

		await inheritAttachments(root, "session-a", "session-b");

		expect((await fork.list()).map((one) => one.change.label)).toEqual([
			"said just now",
			"newer",
			"older",
		]);
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
		const dir = join(root, id);
		for (const name of await readdir(dir)) {
			await utimes(join(dir, name), when, when);
		}
		await utimes(dir, when, when);
	}

	it("gives back a directory nothing has touched in a long time", async () => {
		await sessionAged("long-gone", 40 * DAY);
		await sessionAged("yesterday", 1 * DAY);

		const taken = await pruneAttachments(root, { olderThanMs: 30 * DAY });

		expect(taken).toBe(1);
		expect(await readdir(root)).toEqual(["yesterday"]);
	});

	it("knows its own by the name the store would have written", async () => {
		// A session id is rewritten to something a path can hold before
		// it becomes a directory name. Comparing the raw id against the
		// written name means a session whose id carries a slash or a
		// colon never matches its own, and the sweep that promises never
		// to touch the caller's directory takes exactly that one.
		const id = "2026-08-06T00:11:22_a/b";
		await createAttachmentStore(root, id).attach(change("x#awkward"));
		const when = new Date(Date.now() - 90 * DAY);
		const [written] = await readdir(root);
		for (const name of await readdir(join(root, written))) {
			await utimes(join(root, written, name), when, when);
		}

		const taken = await pruneAttachments(root, {
			olderThanMs: 30 * DAY,
			keep: id,
		});

		expect(taken).toBe(0);
		expect(await readdir(root)).toEqual([written]);
	});

	it("does not age a session that keeps freshening what it holds", async () => {
		// Rewriting an attachment in place does not move the directory's
		// own timestamp, only the file's, so judging the directory ages
		// an actively used session as though it had been abandoned.
		const store = createAttachmentStore(root, "busy");
		await store.attach(change("x#busy"));
		const old = new Date(Date.now() - 90 * DAY);
		await utimes(join(root, "busy"), old, old);
		await store.attach(change("x#busy"));

		const taken = await pruneAttachments(root, { olderThanMs: 30 * DAY });

		expect(taken).toBe(0);
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

	it("leaves a loose file where it lies, however old", async () => {
		// Everything attached before scoping existed sits flat in the
		// root. It belongs to no session, so no session's rule should
		// decide its fate, and deleting somebody's attachment to tidy up
		// is a poor trade for the disk it returns.
		//
		// Putting these on the clock was tried and taken back out. An
		// orphan is a file nothing has written since scoping landed, so
		// its own age gives no grace to the population the grace was
		// written for: every one of them would go on the first session
		// start after such a sweep shipped.
		const loose = join(root, "from_before_1.json");
		await writeFile(loose, "{}", "utf8");
		const when = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
		await utimes(loose, when, when);

		const taken = await pruneAttachments(root, { olderThanMs: 0 });

		expect(taken).toBe(0);
		expect(await readdir(root)).toEqual(["from_before_1.json"]);
	});
});

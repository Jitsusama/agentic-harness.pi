/**
 * A session following its install: it reloads itself when the install
 * moves, at a moment that loses nothing, and a session that is not
 * somebody's to sit at never does.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	follow,
	HELD_ENTRY,
	HELD_MS,
	WAITING_ENTRY,
} from "../../../extensions/reload-workflow/follow.ts";
import type { PackageSettings } from "../../../lib/internal/reload/settings.ts";
import { reloadSlot } from "../../../lib/internal/reload/slot.ts";
import { announceJobHost, type JobHost } from "../../../lib/jobs/index.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";
import { quietFor, until } from "../../support/until.ts";

const QUIET_MS = 40;
const repos: string[] = [];
const stops: (() => void)[] = [];

afterEach(async () => {
	for (const stop of stops.splice(0)) stop();
	// Stop the process's follower, so the next test starts on its own.
	await follow({} as never, { hasUI: false } as never, settingsFor(""), () => ({
		root: "",
	}));
	const slot = reloadSlot();
	slot.request = undefined;
	slot.dispatched = false;
	slot.dispatchedAt = undefined;
	slot.performing = undefined;
	for (const repo of repos.splice(0)) disposeRepo(repo);
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const dirs: string[] = [];

/**
 * A session running one version of an install named by a link, whose
 * link has moved onto another: no git, so no watch hears anything, as
 * when a session's watch was lost.
 */
async function behind({ swapped = false, installUnread = false } = {}) {
	const install = mkdtempSync(join(tmpdir(), "install-"));
	dirs.push(install);
	const was = join(install, "versions", "aaaa");
	const now = join(install, "versions", "bbbb");
	mkdirSync(was, { recursive: true });
	mkdirSync(now, { recursive: true });
	const link = join(install, "current");
	symlinkSync(join("versions", "bbbb"), link);
	const prompted: string[] = [];
	const entries: { type: string; data: unknown }[] = [];
	const pi = {
		events: createEventBus(),
		sendUserMessage: (text: string) => prompted.push(text),
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
	};
	const follower = await follow(
		pi as never,
		{ hasUI: true, isIdle: () => true } as never,
		settingsFor(link),
		// Swapped, it runs a version of another install than its settings
		// name; an install the start couldn't read is none at all.
		() => ({
			root: was,
			install: swapped
				? join(install, "elsewhere", "versions", "cccc")
				: installUnread
					? undefined
					: now,
		}),
		{ env: {}, quietMs: QUIET_MS },
	);
	return { follower, prompted, entries };
}

function settingsFor(root: string): PackageSettings {
	return {
		read: () => ["git:example.com/the-package"],
		write: async () => {},
		rootOf: () => root,
	};
}

/** A session on an install at a fresh repo, and what it sent to its prompt. */
async function session({
	idle = true,
	hasUI = true,
	swapped = false,
	pending = 0,
	// The session was replaced: pi refuses this runtime's pi.
	stale = false,
} = {}) {
	const install = await freshRepo("install");
	repos.push(install);
	const events = createEventBus();
	const prompted: string[] = [];
	const host: JobHost = {
		start: () => {
			throw new Error("not in this test");
		},
		pending: () => pending,
	};
	stops.push(announceJobHost(events, host));
	const pi = {
		events,
		sendUserMessage: (text: string) => {
			if (stale) throw new Error("This extension ctx is stale.");
			prompted.push(text);
		},
	};
	let busy = !idle;
	const follower = await follow(
		pi as never,
		{ hasUI, isIdle: () => !busy } as never,
		settingsFor(install),
		() => ({ root: swapped ? "/a/tree" : install, install }),
		{ env: {}, quietMs: QUIET_MS },
	);
	return {
		install,
		prompted,
		follower,
		settle: () => {
			busy = false;
			follower?.consider(true);
		},
	};
}

async function land(dir: string, message: string): Promise<void> {
	writeFileSync(join(dir, `${Date.now()}.txt`), message);
	await git(dir, "add", "-A");
	await git(dir, "commit", "-qm", message);
}

describe("following the install from a runtime the session replaced", () => {
	it("takes its request back rather than throwing", async () => {
		const { install } = await session({ stale: true });

		await land(install, "feat: something to try");
		await until("the request is taken back", () => {
			const slot = reloadSlot();
			return slot.dispatched === false && slot.request === undefined;
		});
	});
});

describe("following the install", () => {
	it("reloads an idle session itself, saying what came in", async () => {
		const { install, prompted } = await session();

		await land(install, "feat: something to try");

		await until("the reload is asked for", () => prompted.length > 0);
		expect(prompted).toEqual(["/harness reload"]);
		expect(reloadSlot().request).toEqual({
			reason: "feat: something to try",
			by: "self",
		});
	});

	it("names what lands while its reload waits for the session", async () => {
		const { install, prompted } = await session();

		await land(install, "feat: the first thing");
		await until("the reload is asked for", () => prompted.length > 0);
		await land(install, "feat: the second thing");

		await until("the reason names both", () =>
			String(reloadSlot().request?.reason).includes("second"),
		);
		expect(reloadSlot().request?.reason).toBe(
			"feat: the second thing; feat: the first thing",
		);
		expect(prompted).toEqual(["/harness reload"]);
	});

	it("waits for a busy session's run to end", async () => {
		const { install, prompted, settle } = await session({ idle: false });

		await land(install, "feat: something to try");
		await quietFor(QUIET_MS, 4);
		expect(prompted).toEqual([]);

		settle();
		await until("the reload is asked for", () => prompted.length > 0);
	});

	it("does not wait for background jobs, which a reload carries over", async () => {
		const { install, prompted } = await session({ pending: 1 });

		await land(install, "feat: something to try");
		await until("the reload is asked for", () => prompted.length > 0);
	});

	it("comes up to an install whose link moved without its watch hearing", async () => {
		const { follower, prompted } = await behind();

		follower?.consider();

		await until("the reload is asked for", () => prompted.length > 0);
		expect(prompted).toEqual(["/harness reload"]);
	});

	it("asks its own reload again once held with none under way, saying why", async () => {
		const { follower, prompted, entries } = await behind();
		const slot = reloadSlot();
		slot.request = { reason: "the install moved", by: "self" };
		slot.dispatched = true;
		slot.dispatchedAt = Date.now() - HELD_MS;

		follower?.consider();

		await until("the reload is asked again", () => prompted.length > 0);
		expect(entries).toMatchObject([
			{ type: HELD_ENTRY, data: { dispatched: true, performing: false } },
		]);
	});

	it("leaves a held reload under way alone, saying why once", async () => {
		const { follower, prompted, entries } = await behind();
		const slot = reloadSlot();
		slot.request = { reason: "the install moved", by: "self" };
		slot.dispatched = true;
		slot.dispatchedAt = Date.now() - HELD_MS;
		slot.performing = true;

		follower?.consider();
		follower?.consider();

		await quietFor(QUIET_MS, 4);
		expect(prompted).toEqual([]);
		expect(entries).toMatchObject([
			{ type: HELD_ENTRY, data: { performing: true } },
		]);
	});

	it("says once why it holds back from a session that runs another install", async () => {
		const { follower, prompted, entries } = await behind({ swapped: true });

		follower?.consider();
		follower?.consider();

		await quietFor(QUIET_MS, 4);
		expect(prompted).toEqual([]);
		expect(entries).toMatchObject([
			{ type: WAITING_ENTRY, data: { reason: "it runs a tree" } },
		]);
	});

	it("says once why it holds back while another's reload waits", async () => {
		const { follower, prompted, entries } = await behind();
		reloadSlot().request = { reason: "asked", by: "agent" };

		follower?.consider();
		follower?.consider();

		await quietFor(QUIET_MS, 4);
		expect(prompted).toEqual([]);
		expect(entries).toMatchObject([
			{
				type: WAITING_ENTRY,
				data: { reason: "another reload is waiting", by: "agent" },
			},
		]);
	});

	it("reads the install again when the start couldn't, rather than hold back", async () => {
		// Thirty sessions started at once on 30 October; three never followed.
		const { follower, prompted } = await behind({ installUnread: true });

		follower?.consider();

		await until("the reload is asked for", () => prompted.length > 0);
	});

	it("never moves a session running a tree, or one nobody sits at", async () => {
		const swapped = await session({ swapped: true });
		await land(swapped.install, "feat: not for a tree");
		await quietFor(QUIET_MS, 4);
		expect(swapped.prompted).toEqual([]);

		const headless = await session({ hasUI: false });
		expect(headless.follower).toBeUndefined();
	});
});

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
	RESTARTING_ENTRY,
	WAITING_ENTRY,
} from "../../../extensions/reload-workflow/follow.ts";
import type { PackageSettings } from "../../../lib/internal/reload/settings.ts";
import { reloadSlot } from "../../../lib/internal/reload/slot.ts";
import {
	isRestartAsk,
	RESTART_ASK,
	type RestartAsk,
} from "../../../lib/internal/session/park.ts";
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
	slot.rolling = undefined;
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
async function behind({
	swapped = false,
	installUnread = false,
	spreadMs = 0,
	// Its extension links, and when its process started against them.
	extensions = "/nonexistent/extensions",
	startedAt = Date.now(),
	// How its holder answers a restart, if anything here answers one.
	answer,
	// It already runs the version its install's link names.
	current = false,
}: {
	current?: boolean;
	swapped?: boolean;
	installUnread?: boolean;
	spreadMs?: number;
	extensions?: string;
	startedAt?: number;
	answer?: (ask: RestartAsk) => void;
} = {}) {
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
	const notices: string[] = [];
	const asks: RestartAsk[] = [];
	const pi = {
		events: createEventBus(),
		sendUserMessage: (text: string) => prompted.push(text),
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
	};
	pi.events.on(RESTART_ASK, (data) => {
		if (!isRestartAsk(data)) return;
		asks.push({ ...data });
		answer?.(data);
	});
	const ctx = {
		hasUI: true,
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => "the-session",
			getSessionFile: () => "/logs/the-session.jsonl",
		},
		ui: { notify: (text: string) => notices.push(text) },
	};
	const follower = await follow(
		pi as never,
		ctx as never,
		settingsFor(link),
		// Swapped, it runs a version of another install than its settings
		// name; an install the start couldn't read is none at all.
		() => ({
			root: current ? now : was,
			install: swapped
				? join(install, "elsewhere", "versions", "cccc")
				: installUnread
					? undefined
					: now,
		}),
		{ env: {}, quietMs: QUIET_MS, spreadMs, extensions, startedAt },
	);
	return { follower, prompted, entries, notices, asks };
}

/**
 * An extensions folder whose link moved after the process started: made
 * onto a first target, repointed onto a second, the first then gone, as
 * the Shopify proxy's link was on 11 November.
 */
function movedLinks(): { extensions: string; startedAt: number } {
	const root = mkdtempSync(join(tmpdir(), "extensions-"));
	dirs.push(root);
	const first = join(root, "first");
	const second = join(root, "second");
	mkdirSync(first);
	mkdirSync(second);
	const extensions = join(root, "extensions");
	mkdirSync(extensions);
	// Well before the link moved, so a coarse clock can't put them together.
	const startedAt = Date.now() - 60_000;
	symlinkSync(second, join(extensions, "the-proxy"));
	rmSync(first, { recursive: true });
	return { extensions, startedAt };
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
	// How long idle reloads are spread over; none, unless a case is about it.
	spreadMs = 0,
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
		{ env: {}, quietMs: QUIET_MS, spreadMs },
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

	it("holds an idle session's reload to its place in the spread", async () => {
		const { install, prompted } = await session({ spreadMs: 60 * 60_000 });

		await land(install, "feat: something to try");
		await quietFor(QUIET_MS, 4);

		expect(prompted).toEqual([]);
	});

	it("reloads a session whose run ends at once, whatever its place", async () => {
		const { install, prompted, settle } = await session({
			idle: false,
			spreadMs: 60 * 60_000,
		});

		await land(install, "feat: something to try");

		// A run ends each time it is looked at, so one ends after the move
		// is heard however long the watch takes to hear it; heard while
		// idle, it would wait its place.
		await until("the reload is asked for", () => {
			settle();
			return prompted.length > 0;
		});
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

	it("starts again through its holder when an extension link moved, rather than reload", async () => {
		const { follower, prompted, entries, asks } = await behind({
			...movedLinks(),
			answer: (ask) => {
				ask.restarting = true;
			},
		});

		follower?.consider();

		await until("the restart is asked for", () => asks.length > 0);
		expect(asks, "the restart names the session's own log").toEqual([
			{ session: "the-session", sessionFile: "/logs/the-session.jsonl" },
		]);
		await quietFor(QUIET_MS, 4);
		expect(prompted, "a reload would load the moved link half stale").toEqual(
			[],
		);
		expect(entries, "the log says why it starts again").toMatchObject([
			{ type: RESTARTING_ENTRY, data: { links: ["the-proxy"] } },
		]);
	});

	it("keeps its code and says why when its holder can't start it again", async () => {
		const { follower, prompted, entries, notices, asks } = await behind({
			...movedLinks(),
			answer: (ask) => {
				ask.why = "its person was at its window in the last ten minutes";
			},
		});

		follower?.consider();
		await until("the restart is asked for", () => asks.length > 0);
		follower?.consider();

		await quietFor(QUIET_MS, 4);
		expect(asks, "it asks again only after a while").toHaveLength(1);
		expect(prompted, "it never reloads onto the moved link").toEqual([]);
		expect(entries, "the log says why, once").toMatchObject([
			{
				type: WAITING_ENTRY,
				data: {
					reason: expect.stringContaining("its person was at its window"),
					links: ["the-proxy"],
				},
			},
		]);
		expect(notices, "its person is told once").toHaveLength(1);
	});

	it("starts again when a reload brought it up on moved links, install moved or not", async () => {
		// Every pi's first swap after this lands is a reload by the follower
		// it replaces, so the new runtime is the first that can say.
		const { follower, prompted, asks } = await behind({
			...movedLinks(),
			current: true,
			answer: (ask) => {
				ask.restarting = true;
			},
		});

		follower?.consider();

		await until("the restart is asked for", () => asks.length > 0);
		expect(prompted, "nothing reloads it again").toEqual([]);
	});

	it("starts an idle runtime reloaded on moved links again once its place comes", async () => {
		// Each look once counted its place afresh, so an idle one never went.
		const { follower, asks } = await behind({
			...movedLinks(),
			current: true,
			spreadMs: QUIET_MS,
			answer: (ask) => {
				ask.restarting = true;
			},
		});

		await until("the restart is asked for", () => {
			follower?.consider();
			return asks.length > 0;
		});
	});

	it("asks nothing of a current runtime whose links are older than it", async () => {
		const links = movedLinks();
		const { follower, prompted, asks } = await behind({
			extensions: links.extensions,
			startedAt: Date.now() + 60_000,
			current: true,
		});

		follower?.consider();

		await quietFor(QUIET_MS, 4);
		expect(asks, "no restart").toEqual([]);
		expect(prompted, "no reload").toEqual([]);
	});

	it("reloads as before when its extension links are older than it", async () => {
		const links = movedLinks();
		const { follower, prompted, asks } = await behind({
			extensions: links.extensions,
			startedAt: Date.now() + 60_000,
		});

		follower?.consider();

		await until("the reload is asked for", () => prompted.length > 0);
		expect(asks, "nothing needs a new process").toEqual([]);
	});

	it("asks nothing while a rollover switches the session's log", async () => {
		// On 3 November a reload begun as a rollover switched finished on
		// the log left behind.
		const { follower, prompted } = await behind();
		reloadSlot().rolling = true;

		follower?.consider();

		await quietFor(QUIET_MS, 4);
		expect(prompted).toEqual([]);
		expect(reloadSlot().request).toBeUndefined();
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

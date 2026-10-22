/**
 * A session following its install: it reloads itself when the install
 * moves, at a moment that loses nothing, and a session that is not
 * somebody's to sit at never does.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { follow } from "../../../extensions/reload-workflow/follow.ts";
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
	for (const repo of repos.splice(0)) disposeRepo(repo);
});

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
		sendUserMessage: (text: string) => prompted.push(text),
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
		finishJobs: () => {
			pending = 0;
		},
	};
}

async function land(dir: string, message: string): Promise<void> {
	writeFileSync(join(dir, `${Date.now()}.txt`), message);
	await git(dir, "add", "-A");
	await git(dir, "commit", "-qm", message);
}

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

	it("waits for background jobs, which a reload would stop", async () => {
		const { install, prompted, settle, finishJobs } = await session({
			pending: 1,
		});

		await land(install, "feat: something to try");
		await quietFor(QUIET_MS, 4);
		settle();
		expect(prompted).toEqual([]);

		finishJobs();
		settle();
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

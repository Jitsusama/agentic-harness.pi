/**
 * A hosted conversation leaves the process's reload machinery alone: it
 * says nothing in `loaded/`, follows nothing, and reloads nothing itself,
 * since each of those is one per process and shared by every conversation.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it } from "vitest";
import { follow } from "../../../extensions/reload-workflow/follow.ts";
import {
	PACKAGE_NAME,
	tellPiPackages,
} from "../../../extensions/reload-workflow/lifecycle.ts";
import {
	HOSTED_RELOAD,
	performReload,
	requestReload,
} from "../../../extensions/reload-workflow/transitions.ts";
import type { PackageSettings } from "../../../lib/internal/reload/settings.ts";
import { reloadSlot } from "../../../lib/internal/reload/slot.ts";
import { installTestHost } from "../../support/session-host.ts";

let root: string;
let host: ReturnType<typeof installTestHost>;

/** Settings naming an install kept as pi-packages keeps it, in versions/. */
function installed(): PackageSettings {
	const version = join(root, "package", "versions", "v1");
	mkdirSync(version, { recursive: true });
	writeFileSync(
		join(version, "package.json"),
		JSON.stringify({ name: PACKAGE_NAME }),
	);
	return {
		read: () => ["git:example.com/the-package"],
		write: async () => {},
		rootOf: () => version,
	};
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hosted-reload-"));
	host = installTestHost();
});
afterEach(() => {
	host.dispose();
	reloadSlot().request = undefined;
	rmSync(root, { recursive: true, force: true });
});

it("says nothing of what it loaded, and leaves the process's exit alone", () => {
	const said = join(root, "package", "loaded", String(process.pid));
	const settings = installed();
	host.dispose();
	tellPiPackages(settings);
	expect(existsSync(said), "plain pi says what it loaded").toBe(true);
	rmSync(said);

	host = installTestHost();
	const exits = process.listenerCount("exit");
	tellPiPackages(settings);

	expect(
		existsSync(said),
		"the host says what its process loaded, not a conversation",
	).toBe(false);
	expect(process.listenerCount("exit")).toBe(exits);
});

it("follows no install, even with a screen", async () => {
	const follower = await follow(
		{ events: createEventBus() } as never,
		{ hasUI: true, isIdle: () => true } as never,
		installed(),
		() => ({ root }),
		{ env: {} },
	);

	expect(follower).toBeUndefined();
});

it("refuses a reload the agent asks for, queuing nothing", async () => {
	await expect(
		requestReload("try it", undefined, installed(), () => {}),
	).rejects.toThrow(HOSTED_RELOAD);
	expect(reloadSlot().request).toBeUndefined();
});

it("reloads nothing from the command, and says why", async () => {
	const said: string[] = [];
	let reloads = 0;
	const ctx = {
		ui: { notify: (text: string) => said.push(text) },
		reload: async () => {
			reloads += 1;
		},
	};

	await performReload(ctx as never, { root }, installed());

	expect({ reloads, said }).toEqual({ reloads: 0, said: [HOSTED_RELOAD] });
});

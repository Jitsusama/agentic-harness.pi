/**
 * A hosted conversation leaves the process's reload machinery alone: it
 * follows nothing and reloads nothing itself, since each of those is one
 * per process and shared by every conversation. It still says what the
 * process loaded, so the version is kept, but never takes that back.
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
import { withSession } from "../../../lib/core/session/index.ts";
import type { PackageSettings } from "../../../lib/internal/reload/settings.ts";
import { reloadSlot } from "../../../lib/internal/reload/slot.ts";
import { installTestHost } from "../../support/session-host.ts";

/** Where the process keeps the file it said, as lifecycle.ts names it. */
const SAID_FILE = Symbol.for("agentic-harness.reload.said-file");

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

it("says what the host loaded, so it is kept, and adds no exit listener", () => {
	const said = join(root, "package", "loaded", String(process.pid));
	const settings = installed();
	Reflect.deleteProperty(globalThis, SAID_FILE);
	const exits = process.listenerCount("exit");

	tellPiPackages(settings);
	host.host.close("a", "its person closed it");
	tellPiPackages(settings);

	expect(
		existsSync(said),
		"the version the host's conversations run is said, and A's close keeps it",
	).toBe(true);
	expect(process.listenerCount("exit")).toBe(exits);

	host.dispose();
	Reflect.deleteProperty(globalThis, SAID_FILE);
	tellPiPackages(settings);
	expect(
		process.listenerCount("exit"),
		"plain pi takes its file back as it exits",
	).toBe(exits + 1);
	host = installTestHost();
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
	expect(
		withSession("a", () => reloadSlot().request),
		"the conversation's slot holds no request",
	).toBeUndefined();
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

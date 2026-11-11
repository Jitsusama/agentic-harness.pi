/**
 * A host's conversations follow the install as plain pi does: when it
 * moves, each conversation asks its host to reload it alone between its
 * runs, and its new runtime says the move was its own, not anybody's
 * ask. Each has its own follower, so one conversation's start or close
 * leaves the others following.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	type Follower,
	follow,
	stopFollowing,
} from "../../../extensions/reload-workflow/follow.ts";
import { takeHostedLanding } from "../../../extensions/reload-workflow/hosted.ts";
import { landedText } from "../../../extensions/reload-workflow/lifecycle.ts";
import {
	type HostReloadRequest,
	installHost,
	withSession,
} from "../../../lib/core/session/index.ts";
import type { PackageSettings } from "../../../lib/internal/reload/settings.ts";
import type { ReloadLanded } from "../../../lib/internal/reload/slot.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";
import { sessionHost } from "../../support/session-host.ts";
import { quietFor, until } from "../../support/until.ts";

const QUIET_MS = 40;
const IDS = ["a", "b"] as const;

/** One conversation's side of the follower, as its host runs it. */
interface Conversation {
	readonly ctx: object;
	readonly notices: string[];
	readonly prompted: string[];
	busy: boolean;
	follower?: Follower;
}

let install: string;
let uninstall: () => void;
let closeAll: () => void;
/** What the host was asked to reload, in order. */
let asked: [string, HostReloadRequest][];
/** The landing each conversation's new runtime took, by conversation. */
let landings: Map<string, ReloadLanded | undefined>;
/** How the host's runner answers a reload. */
let runner: (id: string) => Promise<void>;
let conversations: Map<string, Conversation>;

function settingsFor(root: string): PackageSettings {
	return {
		read: () => ["git:example.com/the-package"],
		write: async () => {},
		rootOf: () => root,
	};
}

/** Start conversation `id`'s follower, inside it, as its runtime's start does. */
async function start(id: string): Promise<Conversation> {
	const notices: string[] = [];
	const prompted: string[] = [];
	const conversation: Conversation = {
		notices,
		prompted,
		busy: false,
		ctx: {
			// No screen: a background conversation follows too.
			hasUI: false,
			isIdle: () => !conversation.busy,
			sessionManager: { getSessionId: () => id },
			ui: { notify: (text: string) => notices.push(text) },
		},
	};
	const pi = {
		events: createEventBus(),
		sendUserMessage: (text: string) => prompted.push(text),
		appendEntry: () => {},
	};
	conversation.follower = await withSession(id, () =>
		follow(
			pi as never,
			conversation.ctx as never,
			settingsFor(install),
			() => ({ root: install, install }),
			{ env: {}, quietMs: QUIET_MS, spreadMs: 0 },
		),
	);
	conversations.set(id, conversation);
	return conversation;
}

async function land(message: string): Promise<void> {
	writeFileSync(join(install, `${Date.now()}.txt`), message);
	await git(install, "add", "-A");
	await git(install, "commit", "-qm", message);
}

beforeEach(async () => {
	install = await freshRepo("install");
	asked = [];
	landings = new Map();
	conversations = new Map();
	// The new runtime takes the landing the old one left, as its start does.
	runner = async (id) => {
		const ctx = conversations.get(id)?.ctx;
		landings.set(id, ctx ? takeHostedLanding(ctx as never) : undefined);
	};
	const { host } = sessionHost({ pid: process.pid, startedAt: Date.now() });
	uninstall = installHost({
		...host,
		reload: async (id: string, request: HostReloadRequest) => {
			asked.push([id, request]);
			await withSession(id, () => runner(id));
		},
	});
	closeAll = () => {
		for (const id of IDS) host.close(id, "test cleanup");
	};
});

afterEach(() => {
	for (const [id, conversation] of conversations)
		withSession(id, () => stopFollowing(conversation.ctx as never));
	closeAll();
	uninstall();
	disposeRepo(install);
});

it("reloads each conversation through its host, saying the move was its own", async () => {
	const [a, b] = [await start("a"), await start("b")];
	expect(a.follower, "a conversation without a screen follows").toBeDefined();

	await land("feat: something to try");
	await until("both conversations ask", () => asked.length === 2);

	const want = { reason: "feat: something to try" };
	expect(
		[...asked].sort(([x], [y]) => x.localeCompare(y)),
		"B's start left A following",
	).toEqual([
		["a", want],
		["b", want],
	]);
	const landed = landings.get("a");
	expect(landed).toEqual({ reason: "feat: something to try", by: "self" });
	expect(landed && landedText(landed, { root: install, install })).toMatch(
		/^Reloaded between runs, because the install moved: feat: something to try\./,
	);
	expect([a.prompted, b.prompted], "nothing goes through the prompt").toEqual([
		[],
		[],
	]);
});

it("names a second move in the landing while its host still holds the reload", async () => {
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const landed = runner;
	runner = async (id) => {
		await held;
		await landed(id);
	};
	await start("a");

	await land("feat: something to try");
	await until("the reload is asked for", () => asked.length === 1);
	await land("fix: something else");
	// Nothing shows the retelling until the landing, so wait out the watch.
	await quietFor(QUIET_MS, 4);
	release();
	await until("it lands", () => landings.has("a"));

	expect(landings.get("a")?.reason).toMatch(/something to try/);
	expect(landings.get("a")?.reason).toMatch(/something else/);
	expect(asked, "the host is asked once").toHaveLength(1);
});

it("waits for a busy conversation's run to end", async () => {
	const a = await start("a");
	a.busy = true;

	await land("feat: something to try");
	await quietFor(QUIET_MS, 4);
	expect(asked, "nothing reloads while the run goes on").toEqual([]);

	a.busy = false;
	a.follower?.consider(true);
	await until("the reload is asked for", () => asked.length === 1);
	expect(asked).toEqual([["a", { reason: "feat: something to try" }]]);
});

it("says a reload its host failed once, and doesn't ask again at every look", async () => {
	runner = async () => {
		throw new Error("runner busy");
	};
	const a = await start("a");

	await land("feat: something to try");
	await until("the failure is said", () => a.notices.length > 0);
	a.follower?.consider();
	a.follower?.consider(true);
	await quietFor(QUIET_MS, 4);

	expect(asked).toHaveLength(1);
	expect(a.notices).toEqual([
		"Nothing was reloaded: the host could not reload this conversation: runner busy.",
	]);
});

it("stops a closed conversation's follower and leaves the others following", async () => {
	const a = await start("a");
	await start("b");

	withSession("a", () => stopFollowing(a.ctx as never));
	await land("feat: something to try");
	await until("B asks", () => asked.length > 0);
	await quietFor(QUIET_MS, 4);

	expect(asked).toEqual([["b", { reason: "feat: something to try" }]]);
});

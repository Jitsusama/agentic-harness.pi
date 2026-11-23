import {
	type ExtensionAPI,
	type ExtensionRunner,
	type ExtensionUIContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	resetKeyringNotices,
	sayKeyringNotice,
} from "../../../../lib/core/internal/keyring/notices.ts";
import { keepCredentialsInKeyring } from "../../../../lib/core/internal/keyring/session.ts";
import { extensionRunner } from "../../../support/extension-runner.ts";

/** A screen as pi takes one, keeping each thing it was told beside its level. */
function screen(): { ui: ExtensionUIContext; told: string[] } {
	const told: string[] = [];
	// The hook reads only notify; pi's runner wraps the rest.
	const ui = {
		notify: (message: string, level: string) =>
			told.push(`${level}: ${message}`),
	} as never;
	return { ui, told };
}

/** Start a turn in `runner`'s session, as pi does before each model call. */
async function turn(runner: ExtensionRunner): Promise<void> {
	await runner.emit({ type: "turn_start", turnIndex: 0, timestamp: 0 });
}

/** An extension keeping `label` in the keyring, running `move` as each session starts. */
function keeping(label: string, move: () => Promise<void> = async () => {}) {
	return (pi: ExtensionAPI) => keepCredentialsInKeyring(pi, label, move);
}

/** One session whose pi runs two extensions keeping credentials, through pi's own runner. */
function session(manager = SessionManager.inMemory(process.cwd())) {
	return extensionRunner(
		[keeping("Slack"), keeping("Google")],
		process.cwd(),
		manager,
	);
}

describe("keepCredentialsInKeyring, under pi's own runner", () => {
	beforeEach(() => {
		resetKeyringNotices();
	});

	afterEach(() => {
		resetKeyringNotices();
	});

	it("shows a notice once, since pi gives both extensions one session", async () => {
		const one = session();
		const shown = screen();
		one.runner.setUIContext(shown.ui, "tui");
		await one.start();
		sayKeyringNotice({ level: "warning", message: "keyring locked" });
		expect(shown.told).toEqual(["warning: keyring locked"]);
		expect(one.errors).toEqual([]);
	});

	it("shows a notice once on the screen the host rebinds the session to", async () => {
		const one = session();
		const first = screen();
		const second = screen();
		one.runner.setUIContext(first.ui, "tui");
		await one.start();
		one.runner.setUIContext(second.ui, "tui");
		sayKeyringNotice({ level: "warning", message: "keyring locked" });
		expect([first.told, second.told]).toEqual([
			[],
			["warning: keyring locked"],
		]);
	});

	it("shows a notice in each session on the screen pi gave it after it started", async () => {
		const first = session();
		const second = session();
		await first.start();
		await second.start();
		const firstScreen = screen();
		const secondScreen = screen();
		first.runner.setUIContext(firstScreen.ui, "tui");
		second.runner.setUIContext(secondScreen.ui, "tui");
		sayKeyringNotice({ level: "warning", message: "keyring locked" });
		expect([firstScreen.told, secondScreen.told]).toEqual([
			["warning: keyring locked"],
			["warning: keyring locked"],
		]);
	});

	it("keeps a notice said before a session has a screen for its first turn with one, though another session showed it", async () => {
		const first = session();
		const second = session();
		await first.start();
		await second.start();
		sayKeyringNotice({ level: "warning", message: "keyring locked" });
		const firstScreen = screen();
		const secondScreen = screen();
		first.runner.setUIContext(firstScreen.ui, "tui");
		await turn(first.runner);
		expect([firstScreen.told, secondScreen.told]).toEqual([
			["warning: keyring locked"],
			[],
		]);
		second.runner.setUIContext(secondScreen.ui, "tui");
		await turn(second.runner);
		await turn(first.runner);
		expect([firstScreen.told, secondScreen.told]).toEqual([
			["warning: keyring locked"],
			["warning: keyring locked"],
		]);
	});

	it("shows the same words once in a session across a reload, where its copy of the notices outlives the reload", async () => {
		// pi's reload builds new extensions around the session's manager
		// (AgentSession's _buildRuntime), so both runners here share one;
		// pi also evaluates each extension's own copy of the notices again,
		// which a copy loaded once for every extension would outlive.
		const manager = SessionManager.inMemory(process.cwd());
		const before = session(manager);
		const shown = screen();
		before.runner.setUIContext(shown.ui, "tui");
		await before.start();
		sayKeyringNotice({ level: "warning", message: "keyring locked" });
		await before.runner.emit({ type: "session_shutdown", reason: "reload" });
		const after = session(manager);
		after.runner.setUIContext(shown.ui, "tui");
		await after.runner.emit({ type: "session_start", reason: "reload" });
		sayKeyringNotice({ level: "warning", message: "keyring locked" });
		expect(shown.told).toEqual(["warning: keyring locked"]);
		expect([before.errors, after.errors]).toEqual([[], []]);
	});

	it("keeps a notice a session was owed through a reload, for the extensions it starts again", async () => {
		const manager = SessionManager.inMemory(process.cwd());
		const before = session(manager);
		const elsewhere = session();
		const seen = screen();
		elsewhere.runner.setUIContext(seen.ui, "tui");
		await Promise.all([before.start(), elsewhere.start()]);
		sayKeyringNotice({ level: "warning", message: "keyring locked" });
		await before.runner.emit({ type: "session_shutdown", reason: "reload" });
		await elsewhere.runner.emit({
			type: "turn_start",
			turnIndex: 0,
			timestamp: 0,
		});
		const after = session(manager);
		const shown = screen();
		after.runner.setUIContext(shown.ui, "tui");
		await after.runner.emit({ type: "session_start", reason: "reload" });
		expect(shown.told).toEqual(["warning: keyring locked"]);
		expect([before.errors, elsewhere.errors, after.errors]).toEqual([
			[],
			[],
			[],
		]);
	});

	it("forgets what a session was owed when it ends other than by a reload", async () => {
		const manager = SessionManager.inMemory(process.cwd());
		const ending = session(manager);
		const elsewhere = session();
		elsewhere.runner.setUIContext(screen().ui, "tui");
		await Promise.all([ending.start(), elsewhere.start()]);
		sayKeyringNotice({ level: "warning", message: "keyring locked" });
		await ending.runner.emit({ type: "session_shutdown", reason: "quit" });
		const after = session(manager);
		const shown = screen();
		after.runner.setUIContext(shown.ui, "tui");
		await after.runner.emit({ type: "session_start", reason: "resume" });
		expect(shown.told).toEqual([]);
	});

	it("keeps what a session is owed when it starts again on the same manager", async () => {
		const one = session();
		const elsewhere = session();
		elsewhere.runner.setUIContext(screen().ui, "tui");
		await Promise.all([one.start(), elsewhere.start()]);
		sayKeyringNotice({ level: "warning", message: "keyring locked" });
		const shown = screen();
		one.runner.setUIContext(shown.ui, "tui");
		await one.runner.emit({ type: "session_start", reason: "reload" });
		expect(shown.told).toEqual(["warning: keyring locked"]);
		expect([one.errors, elsewhere.errors]).toEqual([[], []]);
	});

	it("stops showing notices in a session that ended, keeping them for the next", async () => {
		const ended = session();
		const endedScreen = screen();
		ended.runner.setUIContext(endedScreen.ui, "tui");
		await ended.start();
		await ended.stop();
		sayKeyringNotice({ level: "info", message: "moved" });
		const next = session();
		const nextScreen = screen();
		next.runner.setUIContext(nextScreen.ui, "tui");
		await next.start();
		expect([endedScreen.told, nextScreen.told]).toEqual([[], ["info: moved"]]);
	});

	it("still moves the credentials when a screen fails to show what was waiting", async () => {
		sayKeyringNotice({ level: "warning", message: "early" });
		let moved = 0;
		const one = extensionRunner(
			keeping("Slack", async () => {
				moved++;
			}),
			process.cwd(),
		);
		one.runner.setUIContext(
			{
				notify: () => {
					throw new Error("a screen gone stale");
				},
			} as never,
			"tui",
		);
		await one.start();
		expect(moved).toBe(1);
		expect(one.errors).toEqual([]);
	});
});

import type {
	ExtensionAPI,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	resetKeyringNotices,
	sayKeyringNotice,
} from "../../../../lib/core/internal/keyring/notices.ts";
import { keepCredentialsInKeyring } from "../../../../lib/core/internal/keyring/session.ts";
import { extensionRunner } from "../../../support/extension-runner.ts";

/** A screen as pi takes one, counting what it was told. */
function screen(): { ui: ExtensionUIContext; told: string[] } {
	const told: string[] = [];
	// The hook reads only notify; pi's runner wraps the rest.
	const ui = { notify: (message: string) => told.push(message) } as never;
	return { ui, told };
}

/** An extension keeping `label` in the keyring, running `move` as each session starts. */
function keeping(label: string, move: () => Promise<void> = async () => {}) {
	return (pi: ExtensionAPI) => keepCredentialsInKeyring(pi, label, move);
}

/** One session whose pi runs two extensions keeping credentials, through pi's own runner. */
function session() {
	return extensionRunner([keeping("Slack"), keeping("Google")], process.cwd());
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
		expect(shown.told).toEqual(["keyring locked"]);
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
		expect([first.told, second.told]).toEqual([[], ["keyring locked"]]);
	});

	it("shows a notice in each session, even those started before pi gave them a screen", async () => {
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
			["keyring locked"],
			["keyring locked"],
		]);
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
		expect([endedScreen.told, nextScreen.told]).toEqual([[], ["moved"]]);
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

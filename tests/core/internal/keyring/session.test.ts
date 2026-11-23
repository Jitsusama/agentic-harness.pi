import {
	createExtensionRuntime,
	type Extension,
	ExtensionRunner,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	resetKeyringNotices,
	sayKeyringNotice,
} from "../../../../lib/core/internal/keyring/notices.ts";
import { keepCredentialsInKeyring } from "../../../../lib/core/internal/keyring/session.ts";
import { type FakePi, fakePi } from "../../../support/fake-pi.ts";

/** A session's screen, counting what it was told. */
function screen(): {
	ui: { notify: (message: string) => void };
	told: string[];
} {
	const told: string[] = [];
	return { ui: { notify: (message) => told.push(message) }, told };
}

/** Run each handler `pi` holds for `event` with `ctx`. */
async function fire(pi: FakePi, event: string, ctx: unknown): Promise<void> {
	for (const handler of pi.recorded.handlers.get(event) ?? [])
		await handler({ type: event }, ctx);
}

/** An extension keeping its credentials in the keyring, with nothing to move. */
function extension(label: string): FakePi {
	const pi = fakePi();
	keepCredentialsInKeyring(pi, label, async () => {});
	return pi;
}

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

/** An extension keeping its credentials in the keyring, as pi loads one. */
function loaded(label: string): Extension {
	const extension: Extension = {
		path: label,
		resolvedPath: label,
		sourceInfo: {
			path: label,
			source: "sdk",
			scope: "temporary",
			origin: "top-level",
		},
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	// The keyring's session hook uses only `on`; pi's runner reads the rest.
	const api = {
		on(name: string, handler: Handler) {
			extension.handlers.set(name, [
				...(extension.handlers.get(name) ?? []),
				handler,
			]);
		},
	} as never;
	keepCredentialsInKeyring(api, label, async () => {});
	return extension;
}

/** One session whose pi runs both extensions, through pi's own runner. */
function bothInOneSession(): ExtensionRunner {
	return new ExtensionRunner(
		[loaded("Slack"), loaded("Google")],
		createExtensionRuntime(),
		process.cwd(),
		SessionManager.inMemory(process.cwd()),
		{} as never,
	);
}

/** A screen as pi takes one, counting what it was told. */
function piScreen(): { ui: never; told: string[] } {
	const told: string[] = [];
	const ui = { notify: (message: string) => told.push(message) };
	return { ui: ui as never, told };
}

describe("keepCredentialsInKeyring, under pi's own runner", () => {
	beforeEach(() => {
		resetKeyringNotices();
	});

	afterEach(() => {
		resetKeyringNotices();
	});

	it("shows a notice once, since pi gives both extensions one screen", async () => {
		const runner = bothInOneSession();
		const screen = piScreen();
		runner.setUIContext(screen.ui, "interactive");
		await runner.emit({ type: "session_start", reason: "startup" });
		sayKeyringNotice({ level: "warning", message: "keyring locked" });
		expect(screen.told).toEqual(["keyring locked"]);
	});

	it("shows a notice once on the screen the host rebinds the session to", async () => {
		const runner = bothInOneSession();
		const first = piScreen();
		const second = piScreen();
		runner.setUIContext(first.ui, "interactive");
		await runner.emit({ type: "session_start", reason: "startup" });
		runner.setUIContext(second.ui, "interactive");
		sayKeyringNotice({ level: "warning", message: "keyring locked" });
		expect([first.told, second.told]).toEqual([[], ["keyring locked"]]);
	});
});

describe("keepCredentialsInKeyring", () => {
	beforeEach(() => {
		resetKeyringNotices();
	});

	afterEach(() => {
		resetKeyringNotices();
	});

	it("shows a notice once on a screen two extensions share", async () => {
		const slack = extension("Slack");
		const google = extension("Google");
		const session = screen();
		await fire(slack, "session_start", session);
		await fire(google, "session_start", session);
		sayKeyringNotice({ level: "warning", message: "keyring locked" });
		expect(session.told).toEqual(["keyring locked"]);
	});

	it("shows a notice on each screen once", async () => {
		const slack = extension("Slack");
		const google = extension("Google");
		const first = screen();
		const second = screen();
		await fire(slack, "session_start", first);
		await fire(google, "session_start", second);
		sayKeyringNotice({ level: "warning", message: "keyring locked" });
		expect([first.told, second.told]).toEqual([
			["keyring locked"],
			["keyring locked"],
		]);
	});

	it("keeps showing notices once one of the extensions stops listening", async () => {
		const slack = extension("Slack");
		const google = extension("Google");
		const session = screen();
		await fire(slack, "session_start", session);
		await fire(google, "session_start", session);
		await fire(slack, "session_shutdown", session);
		sayKeyringNotice({ level: "info", message: "moved" });
		expect(session.told).toEqual(["moved"]);
	});
});

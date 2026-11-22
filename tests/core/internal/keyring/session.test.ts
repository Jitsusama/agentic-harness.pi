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

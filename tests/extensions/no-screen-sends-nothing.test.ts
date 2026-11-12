/**
 * A Slack or Google write that waits on the person's yes is refused where
 * no one can give it: a session with no screen, as a subagent, print or
 * RPC mode, or a host running pi with no terminal, is.
 *
 * On 9 November every one of these gates approved with no screen, "as it
 * always has" (OSPHT4 [70f3e526]), against the rule that nothing is sent
 * without the person saying so. Turning the guard off is the person
 * saying so ahead of time, so that still goes.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	confirmCreateEvent,
	confirmDeleteEmail,
	confirmDeleteEvent,
	confirmSendEmail,
	confirmUpdateEvent,
} from "../../extensions/google-workspace-integration/confirmation.ts";
import {
	confirmEditMessage,
	confirmReaction,
	confirmReply,
	confirmSendMessage,
	confirmSendThread,
	confirmUploadFile,
} from "../../extensions/slack-integration/confirmation.ts";
import {
	restoreSessionModes,
	setSessionMode,
} from "../../lib/guardian/policy.ts";
import { GUARDS } from "../../lib/internal/guardian/guards.ts";

/** A session nobody sits at. */
const NO_SCREEN = { hasUI: false } as unknown as ExtensionContext;

const EMAIL = { to: ["a@example.com"], subject: "Hi", body: "Hello." };
const INVITED = {
	summary: "Sync",
	start: "2026-11-10T10:00:00Z",
	end: "2026-11-10T10:30:00Z",
	attendees: ["a@example.com"],
};

/** Every write each gate guards, raised with no screen. */
const writes: ReadonlyArray<readonly [string, () => Promise<unknown>, string]> =
	[
		[
			"a Slack message",
			() => confirmSendMessage(NO_SCREEN, "#general", "hi"),
			GUARDS.slack.name,
		],
		[
			"a Slack edit",
			() => confirmEditMessage(NO_SCREEN, "#general", "1.1", "hi"),
			GUARDS.slack.name,
		],
		[
			"a Slack reply",
			() => confirmReply(NO_SCREEN, "#general", "1.1", "hi"),
			GUARDS.slack.name,
		],
		[
			"a Slack upload",
			() =>
				confirmUploadFile(NO_SCREEN, "#general", [
					{ path: "/tmp/a.txt", name: "a.txt", size: 1 },
				] as never),
			GUARDS.slack.name,
		],
		[
			"a Slack thread",
			() => confirmSendThread(NO_SCREEN, "#general", [{ text: "hi" }] as never),
			GUARDS.slack.name,
		],
		[
			"a Slack reaction",
			() => confirmReaction(NO_SCREEN, "#general", "1.1", "eyes", "add"),
			GUARDS.slack.name,
		],
		[
			"an email",
			() => confirmSendEmail(NO_SCREEN, EMAIL, false),
			GUARDS.google.name,
		],
		[
			"an email's deletion",
			() => confirmDeleteEmail(NO_SCREEN, "m1", "Hi"),
			GUARDS.google.name,
		],
		[
			"an invitation",
			() => confirmCreateEvent(NO_SCREEN, INVITED),
			GUARDS.google.name,
		],
		[
			"an invitation's change",
			() => confirmUpdateEvent(NO_SCREEN, "e1", INVITED, { summary: "Later" }),
			GUARDS.google.name,
		],
		[
			"an invitation's cancelling",
			() => confirmDeleteEvent(NO_SCREEN, "e1", "Sync", true),
			GUARDS.google.name,
		],
	];

afterEach(() => restoreSessionModes({}));

describe("a write that waits on the person's yes, with no screen", () => {
	it.each(writes)("refuses %s, saying why", async (_what, raise) => {
		expect(await raise()).toMatchObject({
			approved: false,
			redirect: expect.stringContaining("no one is at this session"),
		});
	});

	it.each(writes)(
		"lets %s through once the person turned its guard off",
		async (_what, raise, guard) => {
			setSessionMode(guard, "off");

			expect(await raise()).toMatchObject({ approved: true });
		},
	);

	it("still lets an event nobody else is invited to through, telling nobody", async () => {
		const alone = { ...INVITED, attendees: [] };

		expect({
			created: await confirmCreateEvent(NO_SCREEN, alone),
			cancelled: await confirmDeleteEvent(NO_SCREEN, "e1", "Solo", false),
		}).toMatchObject({
			created: { approved: true },
			cancelled: { approved: true },
		});
	});
});

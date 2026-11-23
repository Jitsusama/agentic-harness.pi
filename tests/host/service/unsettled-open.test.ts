import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	OPEN_UNSETTLED,
	unsettledMessage,
	unsettledSession,
} from "../../../host/service/unsettled-open.ts";

describe("an unsettled open's refusal", () => {
	it("names again the session its words were written for", () => {
		const sessionId = randomUUID();

		expect(
			unsettledSession({
				code: OPEN_UNSETTLED,
				message: unsettledMessage(sessionId),
			}),
		).toBe(sessionId);
	});

	// Every pi reads these words, from hosts that may not have restarted
	// since they were written, so the sentence an older host sends is
	// pinned here as it stands rather than through the helper that writes it.
	it("reads the very words a host already running sends", () => {
		const sessionId = "019a0b1c-2d3e-7f40-8a51-b62c73d84e95";

		expect(
			unsettledSession({
				code: "open_unsettled",
				message: `The conversation's process gave no answer in time, but runs ${sessionId}: attach to it, or close it, rather than open another`,
			}),
		).toBe(sessionId);
	});

	it("names nothing for another code with the same words", () => {
		expect(
			unsettledSession({
				code: "operation_failed",
				message: unsettledMessage(randomUUID()),
			}),
		).toBeUndefined();
	});

	it("names nothing for words it didn't write, or ones with more after", () => {
		const sessionId = randomUUID();

		expect(
			unsettledSession({ code: OPEN_UNSETTLED, message: "No answer in time" }),
		).toBeUndefined();
		expect(
			unsettledSession({
				code: OPEN_UNSETTLED,
				message: `${unsettledMessage(sessionId)}, and more`,
			}),
		).toBeUndefined();
		expect(
			unsettledSession({
				code: OPEN_UNSETTLED,
				message: `Child: ${unsettledMessage(sessionId)}`,
			}),
		).toBeUndefined();
	});

	// The attach words built from the id are never quoted, which holds only
	// for a UUID; on the wire the open's own answer is held to one.
	it("names nothing for words that name something other than a session's id", () => {
		expect(
			unsettledSession({
				code: OPEN_UNSETTLED,
				message: unsettledMessage("$(touch-pwned)"),
			}),
		).toBeUndefined();
		expect(
			unsettledSession({
				code: OPEN_UNSETTLED,
				message: unsettledMessage("not-a-session"),
			}),
		).toBeUndefined();
	});
});

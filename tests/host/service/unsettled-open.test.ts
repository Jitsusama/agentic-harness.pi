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
	});
});

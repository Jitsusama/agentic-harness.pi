import { describe, expect, it } from "vitest";
import {
	IDENTITY_CONTEXT_TYPE,
	identityContext,
} from "../../../extensions/slack-integration/context";

describe("telling the model who it is on Slack", () => {
	it("names the handle it wants used for from: queries", () => {
		const context = identityContext({
			userHandle: "joel.gerber",
			userId: "U08ME9KASG7",
		});

		expect(context?.message.content).toContain("@joel.gerber");
		expect(context?.message.content).toContain("U08ME9KASG7");
		// The handle is only useful to the model if it is told what to
		// do with it: a bare name invites a search by display name,
		// which Slack answers differently.
		expect(context?.message.content).toContain("from:");
	});

	it("says nothing at all before sign-in", () => {
		// Not an empty message: nothing. A message asserting an unknown
		// identity would be spent on every turn of a session that has
		// no Slack access, and would put "undefined" in a query.
		expect(identityContext({})).toBeUndefined();
		expect(identityContext({ userId: "U-ONLY-AN-ID" })).toBeUndefined();
	});

	it("marks the message as context rather than something to read", () => {
		const context = identityContext({ userHandle: "someone", userId: "U1" });

		expect(context?.message.display).toBe(false);
		expect(context?.message.customType).toBe(IDENTITY_CONTEXT_TYPE);
	});
});

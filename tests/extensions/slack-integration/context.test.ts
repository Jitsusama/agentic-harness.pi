import { describe, expect, it } from "vitest";
import {
	IDENTITY_CONTEXT,
	identityText,
} from "../../../extensions/slack-integration/context";
import { standingContextTurn } from "../../../lib/prompt/index.ts";

describe("telling the model who it is on Slack", () => {
	it("names the handle it wants used for from: queries", () => {
		const text = identityText({
			userHandle: "joel.gerber",
			userId: "U08ME9KASG7",
		});

		expect(text).toContain("@joel.gerber");
		expect(text).toContain("U08ME9KASG7");
		// The handle is only useful to the model if it is told what to
		// do with it: a bare name invites a search by display name,
		// which Slack answers differently.
		expect(text).toContain("from:");
	});

	it("says nothing at all before sign-in", () => {
		// Nothing, rather than an identity it does not have, which would
		// put "undefined" in a query.
		expect(identityText({})).toBeNull();
		expect(identityText({ userId: "U-ONLY-AN-ID" })).toBeNull();
	});

	it("omits an id it does not have, rather than saying undefined", () => {
		const text = identityText({ userHandle: "joel.gerber" });

		// A literal "undefined" where an id belongs is an id-shaped thing
		// that is not an id, in the sentence the model trusts for identity.
		expect(text).toContain("@joel.gerber");
		expect(text).not.toContain("undefined");
		expect(text).not.toContain("()");
	});

	it("says it once, however many prompts follow", () => {
		const who = identityText({ userHandle: "joel.gerber", userId: "U1" });
		let ledger = {};
		const said: string[] = [];
		for (let prompt = 0; prompt < 5; prompt++) {
			const turn = standingContextTurn(IDENTITY_CONTEXT, ledger, who, "base");
			expect(turn.systemPrompt).toBe(`base\n\n${who}`);
			if (turn.message) said.push(turn.message.content);
			ledger = turn.ledger;
		}
		expect(said).toEqual([]);
	});

	it("says it when sign-in comes after the session started", () => {
		const first = standingContextTurn(IDENTITY_CONTEXT, {}, null, "base");
		const who = identityText({ userHandle: "joel.gerber" });
		const second = standingContextTurn(
			IDENTITY_CONTEXT,
			first.ledger,
			who,
			"base",
		);
		const third = standingContextTurn(
			IDENTITY_CONTEXT,
			second.ledger,
			who,
			"base",
		);

		expect(second.message?.content).toBe(who);
		expect(second.message?.display).toBe(false);
		expect(third.message).toBeUndefined();
	});
});

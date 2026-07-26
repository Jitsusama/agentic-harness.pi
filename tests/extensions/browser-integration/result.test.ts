/**
 * Explaining a session that is not there.
 *
 * A session closed by the idle timer is indistinguishable, to the
 * caller, from a name they invented. The difference is worth
 * saying: one is their mistake and the other is a timer, and only
 * one of them means their navigation, storage and emulation have
 * quietly gone.
 */

import { describe, expect, it } from "vitest";
import {
	chooseSession,
	missingSession,
	sessionInPlay,
} from "../../../extensions/browser-integration/result.js";

describe("which session a call without a name acts on", () => {
	it("uses the default when it is open", () => {
		expect(sessionInPlay(undefined, "default", ["default", "fr"])).toEqual({
			name: "default",
		});
	});

	it("uses the only session open, and says which", () => {
		// Navigating in a session called fr and then asking for a
		// verdict without repeating the name sent the tool looking for a
		// session nobody had opened, while the right answer sat there
		// alone.
		const chosen = sessionInPlay(undefined, "default", ["fr"]);
		expect(chosen).toMatchObject({ name: "fr" });
		expect("note" in chosen && chosen.note).toContain("fr");
	});

	it("asks which one when several are open", () => {
		expect(sessionInPlay(undefined, "default", ["fr", "de"])).toEqual({
			candidates: ["fr", "de"],
		});
	});

	it("never second-guesses a name it was given", () => {
		// A typo is better reported than quietly redirected to whatever
		// else happens to be open.
		expect(sessionInPlay("typo", "default", ["fr"])).toEqual({
			name: "typo",
		});
	});

	it("lists the open sessions when it has to ask", () => {
		expect(chooseSession(["fr", "de"])).toContain("fr, de");
	});

	it("says how to start when nothing is open", () => {
		expect(chooseSession([])).toContain("browser_go");
	});
});

const OPENS = "Navigate somewhere with browser_go first.";

describe("missingSession", () => {
	it("says a timed-out session timed out, and what went with it", () => {
		const said = missingSession("gs", "idle", OPENS);
		expect(said).toContain("sitting idle");
		expect(said).toContain("storage");
		expect(said).toContain(OPENS);
	});

	it("does not imply the caller invented the name", () => {
		// The old wording, "No session 'gs'", sent a reader looking
		// for a typo that was never there.
		expect(missingSession("gs", "idle", OPENS)).not.toContain("No session");
	});

	it("distinguishes one closed on purpose from one that lapsed", () => {
		expect(missingSession("gs", "closed", OPENS)).toContain("closed earlier");
		expect(missingSession("gs", "closed", OPENS)).not.toContain("idle");
	});

	it("still says plainly when no such session was ever opened", () => {
		expect(missingSession("typo", undefined, OPENS)).toContain(
			"No session 'typo'",
		);
	});

	it("always says how to get one back", () => {
		for (const how of ["idle", "closed", undefined] as const) {
			expect(missingSession("gs", how, OPENS)).toContain(OPENS);
		}
	});
});

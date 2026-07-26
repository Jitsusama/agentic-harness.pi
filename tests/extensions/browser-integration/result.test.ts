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
import { missingSession } from "../../../extensions/browser-integration/result.js";

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

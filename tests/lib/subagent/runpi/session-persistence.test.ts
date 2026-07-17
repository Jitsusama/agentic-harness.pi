import { describe, expect, it } from "vitest";
import { withSessionPersistence } from "../../../../lib/subagent/runpi/supervisor.js";

// A supervised reviewer must persist its session so a
// dropped run can be resumed. The composed args default to
// --no-session (the fleet and legacy runners want that);
// the supervisor, which owns a private artifacts directory,
// swaps that for --session-dir pointing at a per-reviewer
// directory. The private dir keeps the session out of the
// user's session list, so there is no pollution.

describe("withSessionPersistence", () => {
	it("swaps --no-session for --session-dir", () => {
		const args = withSessionPersistence(
			["--mode", "json", "--no-session", "-p", "PROMPT"],
			"/s",
		);
		expect(args).not.toContain("--no-session");
		expect(args).toContain("--session-dir");
		expect(args[args.indexOf("--session-dir") + 1]).toBe("/s");
		// The prompt and its -p sentinel survive in order.
		expect(args.slice(-2)).toEqual(["-p", "PROMPT"]);
	});

	it("appends --session-dir when --no-session is absent", () => {
		const args = withSessionPersistence(["--mode", "json"], "/s");
		expect(args).toContain("--session-dir");
		expect(args[args.indexOf("--session-dir") + 1]).toBe("/s");
	});
});

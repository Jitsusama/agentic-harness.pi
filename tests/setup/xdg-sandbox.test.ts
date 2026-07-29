/**
 * The suite must not read or write the developer's own XDG
 * directories. Asserted rather than assumed, because the failure is
 * silent: a test that writes to the real state directory passes, and
 * the damage shows up later in the developer's own tooling.
 */

import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { cacheDir, dataDir, stateDir } from "../../lib/internal/paths";

describe("the test suite's XDG sandbox", () => {
	it("resolves every directory outside the developer's home", () => {
		// Loading a quest records a session, so an unsandboxed run put
		// records in the real registry under pids belonging to vitest
		// workers. A later reader found those processes gone and offered
		// the sessions back as tabs to restore.
		for (const path of [
			stateDir("quest-workflow"),
			dataDir("quest-workflow"),
			cacheDir("quest-workflow"),
		]) {
			expect(path.startsWith(homedir())).toBe(false);
		}
	});
});

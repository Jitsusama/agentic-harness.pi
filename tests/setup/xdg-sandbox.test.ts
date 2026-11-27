/**
 * The suite must not read or write the developer's own XDG
 * directories. Asserted rather than assumed, because the failure is
 * silent: a test that writes to the real state directory passes, and
 * the damage shows up later in the developer's own tooling.
 */

import { homedir, tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { secretStore } from "../../lib/core/internal/keyring/secrets.ts";
import { cacheDir, dataDir, stateDir } from "../../lib/internal/paths.ts";
import { machineQueueDir } from "../../lib/internal/priority/folder.ts";
import { CHOSEN_FOR_THE_RUN } from "./held-session.ts";

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
			expect(
				path.startsWith(homedir()),
				`${path} lies outside the home directory, ${homedir()}`,
			).toBe(false);
		}
	});

	it("keeps the machine's own jobs folder out of reach", () => {
		// Every session's quest extension writes each quest's weight into
		// the jobs folder, which the machine reads to share itself by
		// quest. A test starting that extension must not replace the
		// machine's real weights with its throwaway quests'.
		const queue = machineQueueDir() ?? "";

		expect(queue).not.toMatch(/^\/run\/user\//);
		expect(
			queue.startsWith(tmpdir()),
			`${queue} lies under the temporary directory, ${tmpdir()}`,
		).toBe(true);
	});

	it("carries none of the developer's mycelium session", () => {
		// A pi the node holds names its held session, realm and wake in
		// MYCELIUM_ variables. A test inheriting MYCELIUM_HELD asked a node
		// it stood up for its own held window, an ask on the developer's
		// behalf no clean run makes, so needs.test.ts failed only there.
		// This reads the setup's work on this runner's own environment;
		// held-session.test.ts plants one, so it fails anywhere.
		const inherited = Object.keys(process.env).filter(
			(name) => name.startsWith("MYCELIUM_") && !CHOSEN_FOR_THE_RUN.has(name),
		);

		expect(inherited).toEqual([]);
	});

	it("keeps credentials out of the developer's keyring", () => {
		// The Google and Slack sign-ins keep their tokens in the keyring; a
		// test signing in must not replace the developer's own.
		expect(secretStore().name).toBe("The test keyring");
	});
});

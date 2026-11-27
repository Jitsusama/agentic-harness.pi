/**
 * What of a held session the setup takes out of a test's environment,
 * given one planted here, so it fails on any runner rather than only in
 * a session the node holds.
 */

import { describe, expect, it } from "vitest";
import { dropHeldSession } from "./held-session.ts";

describe("dropping a held session", () => {
	it("takes every MYCELIUM_ name, one added tomorrow too, and keeps the rest", () => {
		const env: NodeJS.ProcessEnv = {
			MYCELIUM_HELD: "hold-1",
			MYCELIUM_REALM: "work",
			MYCELIUM_SOMETHING_NEW: "x",
			PATH: "/bin",
			NOT_MYCELIUM_HELD: "y",
		};

		dropHeldSession(env);

		expect(env).toEqual({ PATH: "/bin", NOT_MYCELIUM_HELD: "y" });
	});

	// host-run.sh and the end-to-end README name the mycelium
	// attach-client.test.ts drives through it.
	it("keeps the mycelium the caller chose for the run", () => {
		const env: NodeJS.ProcessEnv = {
			MYCELIUM_BIN: "/nix/store/x-mycelium/bin/mycelium",
			MYCELIUM_HELD: "hold-1",
		};

		dropHeldSession(env);

		expect(env).toEqual({ MYCELIUM_BIN: "/nix/store/x-mycelium/bin/mycelium" });
	});
});

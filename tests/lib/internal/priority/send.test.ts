/**
 * Where a bash call runs, decided once for the call, so the interceptor
 * that rewrites it and the mesh that reads it see the same command.
 */

import { describe, expect, it } from "vitest";
import { whereItRuns } from "../../../../lib/internal/priority/send.ts";

describe("where a call runs", () => {
	it("is as written for a command that sends nothing", async () => {
		expect(await whereItRuns("call-1", "ls -la", "/")).toBeUndefined();
	});

	it("is decided once a call, so every reader of it gets the one answer", () => {
		const first = whereItRuns("call-2", "nix build .#x", "/");
		expect(whereItRuns("call-2", "nix build .#x", "/")).toBe(first);
		expect(whereItRuns("call-3", "nix build .#x", "/")).not.toBe(first);
	});
});

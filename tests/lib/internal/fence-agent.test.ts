/**
 * Where a fenced command is told the SSH agent's proxy is: in the
 * proxy's own folder, which the fence binds whole, else its old place.
 */

import { describe, expect, it } from "vitest";
import { agentProxy } from "../../../lib/internal/fence.ts";
import type { Disk } from "../../../lib/internal/fence-disk.ts";

describe("the SSH agent's proxy inside", () => {
	const runtimeDir = "/run/user/1000";
	const holding = (paths: readonly string[]): Disk => ({
		kind: (path) => (paths.includes(path) ? "file" : undefined),
		entries: () => [],
	});

	it("is the socket in the proxy's own folder, which a restart of the proxy can't leave dead", () => {
		expect(
			agentProxy(
				runtimeDir,
				holding([
					"/run/user/1000/pi-agent/agent.sock",
					"/run/user/1000/pi-agent.sock",
				]),
			),
			"the folder's socket wasn't chosen over the old place",
		).toBe("/run/user/1000/pi-agent/agent.sock");
	});

	it("is the old place on a machine whose proxy hasn't moved, and nothing where neither is", () => {
		expect(
			agentProxy(runtimeDir, holding(["/run/user/1000/pi-agent.sock"])),
			"the old place wasn't kept while the folder isn't there",
		).toBe("/run/user/1000/pi-agent.sock");
		expect(
			agentProxy(runtimeDir, holding([])),
			"an agent was named where no proxy is",
		).toBeUndefined();
	});
});

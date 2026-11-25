/**
 * Loading the sandbox, and the fence beneath it, loads no mesh transport.
 * A test setup file reaches the sandbox, so a transport loaded through it
 * binds the real file system before a test's own `node:fs` stands in, and
 * that test's listings go unseen; mesh-never-lost failed 3 of 14 so.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../lib/mesh/transport.ts", () => {
	throw new Error("the sandbox loaded the mesh transport");
});

describe("the sandbox's imports", () => {
	it("load the sandbox and the fence without the mesh transport", async () => {
		// The setup files loaded the sandbox already, before this mock.
		vi.resetModules();
		await expect(
			import("../../../../lib/internal/sandbox/sandbox.ts"),
		).resolves.toBeDefined();
		await expect(
			import("../../../../lib/internal/fence/fence.ts"),
		).resolves.toBeDefined();
		await expect(
			import("../../../../lib/internal/fence/fence-run.ts"),
		).resolves.toBeDefined();
	});
});

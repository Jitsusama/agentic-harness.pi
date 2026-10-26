import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
	currentProcessIdentity,
	localProcessDeps,
	probeProcess,
} from "../../../../lib/core/internal/quest/process-liveness.ts";

// Wrap execFileSync so a test can count the ps processes a call starts:
// each one is a synchronous spawn on pi's session start.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const spawned = vi.mocked(execFileSync);

describe("currentProcessIdentity", () => {
	it("reports the running process's host, pid and a real start token", () => {
		// ps can read this live process on the test host, so a real
		// identity is captured.
		const me = currentProcessIdentity();
		expect(me).toBeDefined();
		if (!me) throw new Error("expected an identity");
		expect(me.hostId).toBe(hostname());
		expect(me.pid).toBe(process.pid);
		expect(me.startToken.length).toBeGreaterThan(0);
	});

	it("asks ps once however often it is asked", () => {
		const first = currentProcessIdentity();
		spawned.mockClear();

		const again = currentProcessIdentity();

		expect(again).toEqual(first);
		expect(spawned.mock.calls.filter(([cmd]) => cmd === "ps")).toHaveLength(0);
	});
});

describe("localProcessDeps", () => {
	it("inspects the running pid as alive with the recorded start token", () => {
		const me = currentProcessIdentity();
		if (!me) throw new Error("expected an identity");
		const found = localProcessDeps().inspect(process.pid);
		expect(found.kind).toBe("alive");
		if (found.kind === "alive") expect(found.startToken).toBe(me.startToken);
	});

	it("resolves the current process to matching end to end", () => {
		const me = currentProcessIdentity();
		if (!me) throw new Error("expected an identity");
		expect(probeProcess(me, localProcessDeps())).toBe("matching");
	});
});

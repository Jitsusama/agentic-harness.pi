import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import {
	currentProcessIdentity,
	localProcessDeps,
	probeProcess,
} from "../../../../lib/internal/quest/process-liveness";

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

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { startTicksFromProcSync } from "../../../../lib/internal/process-ticks.ts";
import {
	currentProcessIdentity,
	localProcessDeps,
	probeProcess,
} from "../../../../lib/internal/quest/process-liveness.ts";

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

	it.runIf(existsSync(`/proc/${process.pid}/stat`))(
		"carries its start in ticks, which its probe goes by",
		() => {
			const me = currentProcessIdentity();
			if (!me) throw new Error("expected an identity");
			expect(me.startTicks).toBe(startTicksFromProcSync(process.pid));
			const drifted = { ...me, startToken: "Thu Jan  1 00:00:00 1970" };
			expect(probeProcess(drifted, localProcessDeps())).toBe("matching");
		},
	);

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

// A host probes every recorded session on its one loop, and each ps it
// started held every conversation while it ran: 459 ms of one turn in a
// soak of twelve (13 November). Where procfs shows the process, it
// answers as ps would, with no child at all.
describe.runIf(existsSync(`/proc/${process.pid}/stat`))(
	"inspecting a pid where procfs shows it",
	() => {
		function psCalls(): number {
			return spawned.mock.calls.filter(([cmd]) => cmd === "ps").length;
		}

		it("reads a live pid's start as ps prints it, without starting ps", () => {
			const printed = execFileSync(
				"ps",
				["-o", "lstart=", "-p", String(process.pid)],
				{ encoding: "utf8" },
			).trim();
			spawned.mockClear();

			const found = localProcessDeps().inspect(process.pid);

			expect(found).toEqual({ kind: "alive", startToken: printed });
			expect(psCalls(), "no ps started").toBe(0);
		});

		it("reads the first process's start as ps prints it too", () => {
			const printed = execFileSync("ps", ["-o", "lstart=", "-p", "1"], {
				encoding: "utf8",
			}).trim();
			spawned.mockClear();

			expect(localProcessDeps().inspect(1)).toEqual({
				kind: "alive",
				startToken: printed,
			});
			expect(psCalls(), "no ps started").toBe(0);
		});

		it("reads a pid nothing holds as gone, without starting ps", () => {
			spawned.mockClear();
			// Past any pid_max the kernel allows, so nothing can hold it.
			expect(localProcessDeps().inspect(2 ** 23)).toEqual({ kind: "gone" });
			expect(psCalls(), "no ps started").toBe(0);
		});

		it("reads its own identity without starting ps", async () => {
			const known = currentProcessIdentity()?.startToken;
			// A load of its own, whose identity is not yet remembered, beside
			// the child_process it loads with.
			vi.resetModules();
			const children = await import("node:child_process");
			const fresh = await import(
				"../../../../lib/internal/quest/process-liveness.ts"
			);
			const started = vi.mocked(children.execFileSync);
			started.mockClear();

			const me = fresh.currentProcessIdentity();

			expect(me?.startToken).toBe(known);
			expect(
				started.mock.calls.filter(([cmd]) => cmd === "ps"),
				"no ps started",
			).toEqual([]);
		});
	},
);

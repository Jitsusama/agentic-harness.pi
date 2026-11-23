import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type Host,
	installHost,
} from "../../../../../lib/core/session/index.ts";
import {
	startTicksFromProcSync,
	type TickedOwner,
} from "../../../../../lib/internal/process-ticks.ts";
import {
	currentProcessIdentity,
	localProcessDeps,
	probeProcess,
} from "../../../../../lib/internal/quest/sessions/process-liveness.ts";

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

// PV3TE0's round 4 (F2, F4): a host reads its boot once, as it starts,
// and an extension may load another instance of the reader; a miss in
// one and not the other named the boot two ways, so every live hosted
// session of that host probed as unknown for the host's life.
describe("currentProcessIdentity in a host", () => {
	const SESSION = "a0000000-0000-4000-8000-000000000002";
	let uninstall: (() => void) | undefined;
	afterEach(() => {
		uninstall?.();
		uninstall = undefined;
	});

	/** Installs a host in this process whose owner is `owner`. */
	const hostedBy = (owner: TickedOwner) => {
		const host: Host = {
			kind: "pi-durable",
			key: "test-host",
			owner,
			holds: () => "idle",
			env: () => ({
				get: () => undefined,
				set() {},
				delete() {},
				snapshot: () => ({}),
			}),
			hints: () => ({}),
			close() {},
			stamp() {},
		};
		uninstall = installHost(host);
	};

	it("names the boot as the host's owner does, not by a reading of its own", () => {
		hostedBy({ pid: process.pid, startedAt: 1, bootId: "the-host's-boot" });

		const me = currentProcessIdentity(SESSION);

		expect(me?.bootToken).toBe("the-host's-boot");
		expect(me?.hosted?.owner.bootId).toBe("the-host's-boot");
	});

	it("names no boot when the host's owner read none", () => {
		hostedBy({ pid: process.pid, startedAt: 1 });

		expect(currentProcessIdentity(SESSION)).not.toHaveProperty("bootToken");
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
				"../../../../../lib/internal/quest/sessions/process-liveness.ts"
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

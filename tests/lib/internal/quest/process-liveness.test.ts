import { describe, expect, it } from "vitest";
import {
	identityFromInspection,
	interpretPsLookup,
	type ProcessIdentity,
	type ProcessInspection,
	probeProcess,
	sameStart,
} from "../../../../lib/internal/quest/process-liveness";

const LOCAL = "host-a";

function id(overrides: Partial<ProcessIdentity> = {}): ProcessIdentity {
	return { hostId: LOCAL, pid: 4321, startToken: "tok-1", ...overrides };
}

function deps(
	inspect: (pid: number) => ProcessInspection,
	localBootToken?: string,
) {
	return {
		localHostId: LOCAL,
		inspect,
		...(localBootToken ? { localBootToken } : {}),
	};
}

describe("probeProcess", () => {
	it("returns unknown when the recorded host is not the local host", () => {
		const probe = probeProcess(
			id({ hostId: "host-b" }),
			deps(() => ({ kind: "alive", startToken: "tok-1" })),
		);
		expect(probe).toBe("unknown");
	});

	it("returns gone when no process holds the recorded pid", () => {
		const probe = probeProcess(
			id(),
			deps(() => ({ kind: "gone" })),
		);
		expect(probe).toBe("gone");
	});

	it("returns gone when the pid was reused by a process with a different start token", () => {
		const probe = probeProcess(
			id(),
			deps(() => ({ kind: "alive", startToken: "tok-2" })),
		);
		expect(probe).toBe("gone");
	});

	it("returns matching when a live process holds the pid with the recorded start token", () => {
		const probe = probeProcess(
			id(),
			deps(() => ({ kind: "alive", startToken: "tok-1" })),
		);
		expect(probe).toBe("matching");
	});

	it("returns gone when the recorded boot token is not the current boot", () => {
		// A reboot invalidates every pid, so a live process holding the
		// recorded pid with a matching start token is a coincidence of
		// reuse, not the process that was recorded.
		const probe = probeProcess(
			id({ bootToken: "boot-1" }),
			deps(() => ({ kind: "alive", startToken: "tok-1" }), "boot-2"),
		);
		expect(probe).toBe("gone");
	});

	it("still probes the pid when the record predates boot tokens", () => {
		// A record written before boot tokens were captured is not
		// evidence of a reboot, so it must not read dead on that basis.
		const probe = probeProcess(
			id(),
			deps(() => ({ kind: "alive", startToken: "tok-1" }), "boot-2"),
		);
		expect(probe).toBe("matching");
	});

	it("still probes the pid when the host has no readable boot token", () => {
		// An unreadable local token means we cannot know which boot we are
		// on, and an inability to observe is never death.
		const probe = probeProcess(
			id({ bootToken: "boot-1" }),
			deps(() => ({ kind: "alive", startToken: "tok-1" })),
		);
		expect(probe).toBe("matching");
	});

	it("returns unknown when the inspection could not determine the process state", () => {
		const probe = probeProcess(
			id(),
			deps(() => ({ kind: "unknown" })),
		);
		expect(probe).toBe("unknown");
	});
});

describe("a start reading moved by a clock correction", () => {
	const recorded = "Sun Oct 11 20:36:26 2026";

	it("still matches the process it was taken from", () => {
		const probe = probeProcess(
			id({ startToken: recorded }),
			deps(() => ({ kind: "alive", startToken: "Sun Oct 11 20:36:30 2026" })),
		);
		expect(probe).toBe("matching");
	});

	it("does not match a process that started well after it", () => {
		const probe = probeProcess(
			id({ startToken: recorded }),
			deps(() => ({ kind: "alive", startToken: "Sun Oct 11 20:45:00 2026" })),
		);
		expect(probe).toBe("gone");
	});

	it("reads tokens that are not times exactly", () => {
		expect(sameStart("tok-1", "tok-1")).toBe(true);
		expect(sameStart("tok-1", "tok-2")).toBe(false);
	});
});

describe("a process recorded with its start in ticks", () => {
	// After 100 suspends on 26 October the kernel's boot time had moved
	// four seconds, and by now a long-lived session's start reading can
	// sit past any tolerance; its ticks never move.
	const recorded = id({
		startToken: "Sun Oct 11 20:36:26 2026",
		bootToken: "boot-1",
		startTicks: 9_000,
	});
	const drifted = () =>
		({ kind: "alive", startToken: "Sun Oct 11 21:36:26 2026" }) as const;
	const withTicks = (ticks: number | undefined, boot = "boot-1") => ({
		...deps(drifted, boot),
		startTicks: () => ticks,
	});

	it("matches its own process however far the start reading drifted", () => {
		expect(probeProcess(recorded, withTicks(9_000))).toBe("matching");
	});

	it("is gone when another process holds the pid", () => {
		expect(
			probeProcess(recorded, {
				...withTicks(9_500),
				inspect: () => ({ kind: "alive", startToken: recorded.startToken }),
			}),
		).toBe("gone");
	});

	it("is judged by its start reading where the ticks can't be read", () => {
		expect(probeProcess(recorded, withTicks(undefined))).toBe("gone");
		expect(probeProcess(recorded, deps(drifted, "boot-1"))).toBe("gone");
	});

	it("is gone from another boot whatever its ticks say", () => {
		expect(probeProcess(recorded, withTicks(9_000, "boot-2"))).toBe("gone");
	});

	it("falls back to its start reading when the record has no boot", () => {
		const { bootToken: _, ...unbooted } = recorded;
		expect(probeProcess(unbooted, withTicks(9_000))).toBe("gone");
	});
});

describe("identityFromInspection", () => {
	it("builds an identity from a live inspection", () => {
		expect(
			identityFromInspection("host-a", 42, {
				kind: "alive",
				startToken: "tok",
			}),
		).toEqual({ hostId: "host-a", pid: 42, startToken: "tok" });
	});

	it("records no identity when the start token could not be read", () => {
		// A synthetic token would later mismatch a real ps reading and
		// read the session dead, so an unreadable capture yields none.
		expect(
			identityFromInspection("host-a", 42, { kind: "gone" }),
		).toBeUndefined();
		expect(
			identityFromInspection("host-a", 42, { kind: "unknown" }),
		).toBeUndefined();
	});
});

describe("interpretPsLookup", () => {
	it("reads a live process's start token from clean output", () => {
		expect(
			interpretPsLookup({
				spawned: true,
				exitStatus: 0,
				stdout: "Mon Jun  1 10:00:00 2026\n",
				stderr: "",
			}),
		).toEqual({ kind: "alive", startToken: "Mon Jun  1 10:00:00 2026" });
	});

	it("reads a clean non-zero exit with no diagnostic as gone", () => {
		expect(
			interpretPsLookup({
				spawned: true,
				exitStatus: 1,
				stdout: "",
				stderr: "",
			}),
		).toEqual({ kind: "gone" });
	});

	it("reads a non-zero exit that printed a diagnostic as unknown, not death", () => {
		// BusyBox ps rejects the query rather than reporting no such pid.
		expect(
			interpretPsLookup({
				spawned: true,
				exitStatus: 1,
				stdout: "",
				stderr: "ps: unrecognized option: o\n",
			}),
		).toEqual({ kind: "unknown" });
	});

	it("reads a non-zero exit whose diagnostic went to stdout as unknown", () => {
		// Some ps variants print the rejection to stdout, not stderr.
		expect(
			interpretPsLookup({
				spawned: true,
				exitStatus: 1,
				stdout: "usage: ps [options]\n",
				stderr: "",
			}),
		).toEqual({ kind: "unknown" });
	});

	it("reads an anomalous zero exit with empty output as unknown, not gone", () => {
		// A live pid always prints its start line on a zero exit; a clean
		// "no such pid" comes via a non-zero exit. An empty zero exit is
		// neither, so it is unknown rather than a false death.
		expect(
			interpretPsLookup({
				spawned: true,
				exitStatus: 0,
				stdout: "   \n",
				stderr: "",
			}),
		).toEqual({ kind: "unknown" });
	});

	it("reads a spawn failure as unknown", () => {
		expect(
			interpretPsLookup({
				spawned: false,
				exitStatus: null,
				stdout: "",
				stderr: "",
			}),
		).toEqual({ kind: "unknown" });
	});
});

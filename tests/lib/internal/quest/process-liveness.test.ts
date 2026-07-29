import { describe, expect, it } from "vitest";
import {
	identityFromInspection,
	interpretPsLookup,
	type ProcessIdentity,
	type ProcessInspection,
	probeProcess,
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

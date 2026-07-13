import { describe, expect, it } from "vitest";
import {
	interpretPsLookup,
	type ProcessIdentity,
	type ProcessInspection,
	probeProcess,
} from "../../../../lib/internal/quest/process-liveness";

const LOCAL = "host-a";

function id(overrides: Partial<ProcessIdentity> = {}): ProcessIdentity {
	return { hostId: LOCAL, pid: 4321, startToken: "tok-1", ...overrides };
}

function deps(inspect: (pid: number) => ProcessInspection) {
	return { localHostId: LOCAL, inspect };
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

	it("returns unknown when the inspection could not determine the process state", () => {
		const probe = probeProcess(
			id(),
			deps(() => ({ kind: "unknown" })),
		);
		expect(probe).toBe("unknown");
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

	it("reads a zero exit with empty output as gone", () => {
		expect(
			interpretPsLookup({
				spawned: true,
				exitStatus: 0,
				stdout: "   \n",
				stderr: "",
			}),
		).toEqual({ kind: "gone" });
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

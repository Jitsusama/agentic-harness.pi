/**
 * Saying which process you meant.
 *
 * The rules here are small and the consequences of getting one wrong
 * are not: every caller uses this to decide whether something may be
 * taken away, so a reading that is confidently wrong reclaims a tree
 * somebody is working in or kills a round somebody is waiting on.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	askedOnce,
	isOwner,
	type Owner,
	ownerNow,
	ownerStanding,
	type ProcessFacts,
	SAME_PROCESS_MS,
	sameProcess,
	systemFacts,
} from "../../../lib/core/process/index.ts";

/**
 * A machine where these pids run, and started when it says, on this
 * boot when it names one.
 */
function machine(
	running: Record<number, number | undefined>,
	boot?: string,
): ProcessFacts {
	return {
		alive: (pid) => pid in running,
		startedAt: async (pid) => running[pid],
		...(boot === undefined ? {} : { bootId: () => boot }),
	};
}

const ours: Owner = { pid: 4001, startedAt: 1_000_000 };

describe("whether two readings are one process", () => {
	it("allows the second the process table rounds away", () => {
		// `ps` reports whole seconds against a recorded millisecond, so
		// the same process reads differently either side of a second.
		expect(sameProcess(1_000_900, 1_000_000)).toBe(true);
	});

	it("refuses a reading that is far earlier, not just far later", () => {
		// Two-sided deliberately. A truncated pid can name `1`, and `1`
		// started at boot, which is emphatically earlier: one-sided, it
		// passes, and the caller then signals init's process group.
		expect(sameProcess(1_000_000, 9_000_000)).toBe(false);
		expect(sameProcess(9_000_000, 1_000_000)).toBe(false);
	});
});

describe("whether a record identifies anybody", () => {
	it("wants both halves, since a pid alone is whoever holds it next", () => {
		expect(isOwner({ pid: 4001, startedAt: 1 })).toBe(true);
		expect(isOwner({ pid: 4001 })).toBe(false);
		expect(isOwner({ startedAt: 1 })).toBe(false);
	});

	it("refuses a pid no process can have", () => {
		// Zero is every process in this group to `kill`, and a negative
		// pid is the group itself. A record carrying either is one a
		// caller must not act on.
		expect(isOwner({ pid: 0, startedAt: 1 })).toBe(false);
		expect(isOwner({ pid: -1, startedAt: 1 })).toBe(false);
	});

	it("takes a boot when it is a name, and refuses one that is not", () => {
		expect(isOwner({ pid: 4001, startedAt: 1, bootId: "b1" })).toBe(true);
		expect(isOwner({ pid: 4001, startedAt: 1, bootId: 7 })).toBe(false);
	});

	it("refuses what is not a record at all", () => {
		expect(isOwner(null)).toBe(false);
		expect(isOwner(undefined)).toBe(false);
		expect(isOwner("4001")).toBe(false);
	});
});

describe("writing down who we are", () => {
	it("says nothing rather than half an identity", async () => {
		// A pid with no start time is a record a later reader must
		// either trust blindly or throw away, and declining to write
		// one is how this avoids forcing that choice on anybody.
		expect(await ownerNow(machine({}), 4001)).toBeUndefined();
	});

	it("pairs the pid with when it started", async () => {
		expect(await ownerNow(machine({ 4001: 1_000_000 }), 4001)).toEqual(ours);
	});

	it("names the boot when the machine will", async () => {
		expect(await ownerNow(machine({ 4001: 1_000_000 }, "b1"), 4001)).toEqual({
			...ours,
			bootId: "b1",
		});
	});
});

describe("where the process that wrote a record stands", () => {
	it("is running when the pid is alive and started when it says", async () => {
		expect(await ownerStanding(ours, machine({ 4001: 1_000_000 }))).toBe(
			"running",
		);
	});

	it("is gone when nothing wears the pid", async () => {
		expect(await ownerStanding(ours, machine({}))).toBe("gone");
	});

	it("is gone when a stranger wears the pid", async () => {
		// Identity outranks liveness. The number is in use, which is
		// exactly what makes this the dangerous case rather than a
		// harmless one.
		expect(await ownerStanding(ours, machine({ 4001: 9_000_000 }))).toBe(
			"gone",
		);
	});

	it("is undecidable when the pid is alive and unidentifiable", async () => {
		// Distinct from gone on purpose. A caller about to delete
		// something must treat this as still there, and it could not do
		// that if this answered with the confident word.
		expect(await ownerStanding(ours, machine({ 4001: undefined }))).toBe(
			"unknown",
		);
	});

	it("is gone when it was written on another boot, without asking", async () => {
		// The first minute after a boot, when the most old records get
		// read, is when their pids are most likely to be some fresh
		// process of this boot. Asking the table would let that stranger
		// answer, so nothing is asked.
		const facts = machine({ 4001: undefined }, "b2");
		let asked = false;
		facts.alive = () => {
			asked = true;
			return true;
		};
		expect(await ownerStanding({ ...ours, bootId: "b1" }, facts)).toBe("gone");
		expect(asked).toBe(false);
	});

	it("is judged as before on this boot, or where no boot is named", async () => {
		const written = { ...ours, bootId: "b1" };
		expect(
			await ownerStanding(written, machine({ 4001: 1_000_000 }, "b1")),
		).toBe("running");
		// The machine cannot name its boot: no grounds to call it gone.
		expect(await ownerStanding(written, machine({ 4001: 1_000_000 }))).toBe(
			"running",
		);
		// Written before boots were kept: pid and start time decide.
		expect(await ownerStanding(ours, machine({ 4001: 1_000_000 }, "b2"))).toBe(
			"running",
		);
	});

	it("is gone when the process exits between the two looks", async () => {
		// What happened on 2026-10-21: a short-lived process wearing an
		// old record's pid was alive for the first look and gone before
		// `ps` answered, and the record read as undecidable instead.
		const running: Record<number, number | undefined> = { 4001: undefined };
		const facts: ProcessFacts = {
			alive: (pid) => pid in running,
			startedAt: async (pid) => {
				delete running[pid];
				return undefined;
			},
		};
		expect(await ownerStanding(ours, facts)).toBe("gone");
	});
});

describe("asking once", () => {
	it("passes the boot through", () => {
		expect(askedOnce(machine({}, "b1")).bootId?.()).toBe("b1");
		expect(askedOnce(machine({})).bootId).toBeUndefined();
	});
});

describe("what the machine itself says", () => {
	it("knows this process is running", async () => {
		expect(systemFacts.alive(process.pid)).toBe(true);
		expect(await systemFacts.startedAt(process.pid)).toBeGreaterThan(0);
	});

	it("reads a process it may not signal as alive, not as gone", () => {
		// Pid 1 is running and not ours to signal, so `kill(1, 0)`
		// raises EPERM. Collapsing that into "gone" was safe reasoning
		// for a supervisor we spawned, since one we cannot signal
		// cannot be ours, and is not safe for a worktree whose holder
		// can be another user's session.
		expect(systemFacts.alive(1)).toBe(true);
	});

	it("says nothing about a pid nothing wears", async () => {
		// Above the system maximum, so it cannot be allocated.
		expect(await systemFacts.startedAt(0x7f_ff_ff_ff)).toBeUndefined();
	});

	it.runIf(process.platform === "linux" || process.platform === "darwin")(
		"names this boot, and the same name each time",
		() => {
			const boot = systemFacts.bootId?.();
			expect(boot).toMatch(/^[0-9a-f-]{36}$/i);
			expect(systemFacts.bootId?.()).toBe(boot);
		},
	);

	it.runIf(process.platform === "linux")(
		"agrees with ps, so records written through ps still match",
		async () => {
			const fromPs = Date.parse(
				execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
					encoding: "utf8",
					env: { ...process.env, LC_ALL: "C" },
				}).trim(),
			);
			const fromProc = await systemFacts.startedAt(process.pid);
			expect(fromProc).toBeDefined();
			expect(sameProcess(fromProc as number, fromPs)).toBe(true);
			expect(Math.abs((fromProc as number) - fromPs)).toBeLessThan(
				SAME_PROCESS_MS / 2,
			);
		},
	);

	it.runIf(process.platform === "linux")(
		"reads a command name holding parentheses and spaces",
		async () => {
			// The name is the one field anybody can set, and a process
			// that calls itself "a) b" must not shift every field after it.
			// The kernel names a process after the file it ran, so a
			// script called that is how a test gets one. Its interpreter
			// waits on a builtin, since running anything else would rename
			// it.
			const { spawn } = await import("node:child_process");
			const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } =
				await import("node:fs");
			const { tmpdir } = await import("node:os");
			const dir = mkdtempSync(`${tmpdir()}/comm-`);
			const script = `${dir}/a) b`;
			const bash = execFileSync("bash", ["-c", "command -v bash"], {
				encoding: "utf8",
			}).trim();
			writeFileSync(script, `#!${bash}\nread -t 5 || true\n`);
			chmodSync(script, 0o755);
			const child = spawn(script, [], { stdio: ["pipe", "ignore", "ignore"] });
			try {
				await new Promise((wake) => setTimeout(wake, 300));
				const pid = child.pid as number;
				expect(readFileSync(`/proc/${pid}/comm`, "utf8")).toBe("a) b\n");
				const fromPs = Date.parse(
					execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
						encoding: "utf8",
						env: { ...process.env, LC_ALL: "C" },
					}).trim(),
				);
				const fromProc = await systemFacts.startedAt(pid);
				expect(sameProcess(fromProc as number, fromPs)).toBe(true);
			} finally {
				child.kill();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

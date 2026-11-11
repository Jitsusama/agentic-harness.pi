/**
 * The hold that keeps plain pi off a conversation's log: open in a host,
 * or kept on a roster for a host's next start, but not a conversation a
 * running host has just let go.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostRegistry } from "../../../../lib/core/session/host.ts";
import type { TickedOwner } from "../../../../lib/internal/process-ticks.ts";
import { hostRunning } from "../../../../lib/internal/session/one-writer.ts";
import { writeParked } from "../../../../lib/internal/session/park.ts";
import { writerHold } from "../../../../lib/internal/session/writer-hold.ts";

const kept = "01a1be5c-fff0-70a1-9301-f505d5634bf6";
const open = "019e0c11-2b2c-7bd5-9e04-1c3c0a5b7a10";
let root: string;
let dir: string;
let rosters: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "writer-hold-"));
	dir = join(root, "hosts");
	rosters = join(root, "host-rosters");
	mkdirSync(dir, { recursive: true });
	mkdirSync(rosters, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A settle long enough that waiting it out shows, and short enough to fit a case. */
const SLOW_SETTLE_MS = 2000;
const running = { pid: 4100, startedAt: 1_794_370_632_830, startTicks: 141 };
const dead = { pid: 4300, startedAt: 1_794_360_000_000, startTicks: 90 };
const standing = async (owner: TickedOwner) =>
	owner.pid === running.pid ? ("running" as const) : ("gone" as const);

/** Write a host's list as session-host.ts does. */
function list(key: string, owner: TickedOwner, sessions: string[]): void {
	const registry: HostRegistry = {
		key,
		owner,
		sessions: sessions.map((id) => ({
			id,
			state: "idle",
			since: "2026-11-11T00:30:00.000Z",
		})),
	};
	writeFileSync(
		join(dir, `${owner.pid}-${owner.startTicks}.json`),
		JSON.stringify(registry),
	);
}

/** Write a host's roster as roster.ts does. */
function roster(key: string, sessions: string[]): void {
	writeFileSync(
		join(rosters, `${key}.json`),
		JSON.stringify({
			v: 1,
			key,
			sessions: sessions.map((sessionId) => ({
				sessionId,
				file: `/home/someone/.pi/sessions/${sessionId}.jsonl`,
				cwd: "/home/someone/src/core.nix",
				attended: false,
				since: "2026-11-11T00:30:00.000Z",
			})),
		}),
	);
}

describe("the hold that keeps plain pi off a log", () => {
	it("is a running host that has it open", async () => {
		list("work-background", running, [open]);
		roster("work-background", [open]);

		expect(await writerHold(open, { dir, standing, rosters })).toEqual({
			key: "work-background",
			realm: "work",
			open: true,
		});
	});

	it("is a crashed host's roster, which its next start takes up", async () => {
		list("work-background", dead, [kept]);
		roster("work-background", [kept]);

		expect(await writerHold(kept, { dir, standing, rosters })).toEqual({
			key: "work-background",
			realm: "work",
			open: false,
		});
	});

	it("is a running host's roster that keeps what it couldn't resume", async () => {
		list("work-background", running, [open]);
		roster("work-background", [open, kept]);

		expect(
			await writerHold(kept, { dir, standing, rosters, settleMs: 300 }),
		).toEqual({ key: "work-background", realm: "work", open: false });
	});

	it("is a running host that parked it, said at once rather than after the settle", async () => {
		list("work-background", running, [open]);
		roster("work-background", [open, kept]);
		const parks = join(root, "park-workflow");
		writeParked(
			{
				session: kept,
				sessionFile: `/home/someone/.pi/sessions/${kept}.jsonl`,
				cwd: "/home/someone/src/core.nix",
				addresses: ["1H56ZJ"],
				parkedAt: "2026-11-11T07:18:12.000Z",
				pid: running.pid,
				wake: join(root, "wake"),
			},
			parks,
		);
		const asked = Date.now();

		const hold = await writerHold(kept, {
			dir,
			standing,
			rosters,
			parks,
			settleMs: SLOW_SETTLE_MS,
		});

		expect(hold).toEqual({
			key: "work-background",
			realm: "work",
			open: false,
			parked: true,
		});
		expect(
			Date.now() - asked,
			"a parked one is never waited on as one the host is letting go",
		).toBeLessThan(SLOW_SETTLE_MS);
	});

	it("is nothing once a running host drops from its roster what it let go", async () => {
		list("work-background", running, [open]);
		roster("work-background", [open, kept]);

		// Asked once the roster is found to keep it: the host drops it while plain pi waits.
		const dropping = async (owner: TickedOwner) => {
			// Lands a few reads into the wait, as a host's drop after its list's does.
			setTimeout(() => roster("work-background", [open]), 300);
			return standing(owner);
		};

		expect(
			await writerHold(kept, {
				dir,
				standing: dropping,
				rosters,
				settleMs: 10_000,
			}),
		).toBeUndefined();
	});

	it("is nothing where no host lists or keeps it", async () => {
		list("work-background", running, [open]);

		expect(await writerHold(kept, { dir, standing, rosters })).toBeUndefined();
	});
});

describe("whether a host runs", () => {
	it("is judged by the process behind its key's list", async () => {
		list("work-background", running, []);
		list("work-attended", dead, []);

		expect(
			await hostRunning("work-background", { dir, standing }),
			"the background host's process runs",
		).toBe(true);
		expect(
			await hostRunning("work-attended", { dir, standing }),
			"the attended host's process is gone",
		).toBe(false);
		expect(
			await hostRunning("home-background", { dir, standing }),
			"no list goes by that key",
		).toBe(false);
	});
});

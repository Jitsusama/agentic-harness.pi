/**
 * The fence's census (lib/internal/fence-census.ts), over a /proc of the
 * test's own: processes laid out as the bash tool and bubblewrap leave
 * them on a machine, as seen on optimus on 16 November. A fenced
 * command's tree ends in bubblewrap's child, with NoNewPrivs and mounts
 * of its own; an unfenced one ends in the machine's mounts without it;
 * a session running nothing is judged by what its environment asks.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CensusPlace,
	censusHolds,
	censusText,
	fenceCensus,
} from "../../../lib/internal/fence-census.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";

/** The boot every live owner here was recorded in. */
const BOOT = "b0075eed-0000-4000-8000-000000000000";

/** Ticks per second, as Linux counts them. */
const HZ = 100;

/** Seconds since boot, so a process started at tick 1000 is long running. */
const UPTIME = 500;

/** The machine's own mount namespace, which pi and its helpers share. */
const MACHINE = "mnt:[4026531841]";

/** A fenced command's mounts, bubblewrap's own. */
const FENCED = "mnt:[4026532999]";

/** Session ids, as pi mints them. */
const ONE = "11111111-1111-4111-8111-111111111111";
const TWO = "22222222-2222-4222-8222-222222222222";

/** One process to lay out, as the census reads it. */
interface Laid {
	readonly pid: number;
	readonly parent: number;
	readonly name: string;
	readonly mounts?: string;
	readonly noNewPrivs?: 0 | 1;
	readonly env?: Record<string, string>;
	readonly argv?: readonly string[];
	readonly startTicks?: number;
}

let root = "";
let proc = "";
let stage = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fence-census-"));
	proc = join(root, "proc");
	stage = join(root, "stage");
	mkdirSync(join(proc, "sys/kernel/random"), { recursive: true });
	mkdirSync(stage);
	writeFileSync(join(proc, "sys/kernel/random/boot_id"), `${BOOT}\n`);
	writeFileSync(join(proc, "uptime"), `${UPTIME}.00 9000.00\n`);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Lay one process's folder out as Linux does. */
function lay(process: Laid): void {
	const folder = join(proc, String(process.pid));
	mkdirSync(join(folder, "ns"), { recursive: true });
	const ticks = process.startTicks ?? 1000;
	const rest = Array.from({ length: 20 }, (_, at) =>
		at === 0 ? String(process.parent) : at === 18 ? String(ticks) : "0",
	);
	writeFileSync(
		join(folder, "stat"),
		`${process.pid} (${process.name}) S ${rest.join(" ")}\n`,
	);
	if (process.noNewPrivs !== undefined) {
		writeFileSync(
			join(folder, "status"),
			`Name:\t${process.name}\nNoNewPrivs:\t${process.noNewPrivs}\n`,
		);
	}
	if (process.mounts !== undefined) {
		symlinkSync(process.mounts, join(folder, "ns/mnt"));
	}
	const env = Object.entries(process.env ?? {}).map(([k, v]) => `${k}=${v}\0`);
	writeFileSync(join(folder, "environ"), env.join(""));
	writeFileSync(
		join(folder, "cmdline"),
		(process.argv ?? [process.name]).map((word) => `${word}\0`).join(""),
	);
}

/** A session's presence, owned by `pid`, hosted when a host is named. */
function presence(
	session: string,
	pid: number,
	more: Partial<Presence> & { readonly host?: string } = {},
): Presence {
	const { host, ...rest } = more;
	return {
		session,
		addresses: [session.slice(0, 6).toUpperCase()],
		groups: [],
		worksOn: "",
		owns: [],
		busy: false,
		at: "2026-11-16T09:00:00Z",
		owner: {
			pid,
			startedAt: 0,
			bootId: BOOT,
			startTicks: 1000,
			...(host === undefined ? {} : { session, host }),
		},
		...rest,
	};
}

/** The place the census reads, over the presences given. */
function place(presences: readonly Presence[]): CensusPlace {
	return { proc, presences, stage, ticksPerSecond: HZ };
}

/** How a command was laid: fenced by bubblewrap, run as it is, or begun. */
type Run = "fenced" | "unfenced" | "starting";

/**
 * One bash call, numbered from `pid`, as the bash tool's keeper leaves
 * it (shell-workflow/command-line.ts): its shell and the tee keeping
 * its output, both outside any fence and carrying the keeper's
 * variable, and under the shell what it ran, which unsets that
 * variable first: bubblewrap's two processes and the command inside
 * them when fenced, the command alone when not, or a bubblewrap that
 * has not yet set NoNewPrivs when only just begun.
 */
function command(pid: number, parent: number, session: string, run: Run): void {
	const keeper = { PI_BASH_KEEP: "/kept/one", PI_SESSION_ID: session };
	const own = { PI_SESSION_ID: session };
	lay({
		pid,
		parent,
		name: "bash",
		mounts: MACHINE,
		noNewPrivs: 0,
		env: keeper,
	});
	lay({
		pid: pid + 1,
		parent: pid,
		name: "tee",
		mounts: MACHINE,
		noNewPrivs: 0,
		env: keeper,
	});
	if (run === "unfenced") {
		lay({
			pid: pid + 2,
			parent: pid,
			name: "sleep",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: own,
		});
		return;
	}
	if (run === "starting") {
		const begun = UPTIME * HZ - 10;
		lay({
			pid: pid + 2,
			parent: pid,
			name: "bwrap",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: own,
			startTicks: begun,
		});
		return;
	}
	lay({
		pid: pid + 2,
		parent: pid,
		name: "bwrap",
		mounts: MACHINE,
		noNewPrivs: 1,
		env: own,
	});
	lay({
		pid: pid + 3,
		parent: pid + 2,
		name: "bwrap",
		mounts: FENCED,
		noNewPrivs: 1,
		env: own,
	});
	lay({
		pid: pid + 4,
		parent: pid + 3,
		name: "sleep",
		mounts: FENCED,
		noNewPrivs: 1,
		env: own,
	});
}

/** A pi, the spawner it starts commands through, and one command. */
function piWithCommand(pid: number, session: string, run: Run): void {
	lay({
		pid,
		parent: 1,
		name: "node",
		mounts: MACHINE,
		noNewPrivs: 0,
		env: {},
	});
	lay({
		pid: pid + 1,
		parent: pid,
		name: "pi-spawner",
		mounts: MACHINE,
		noNewPrivs: 0,
	});
	command(pid + 2, pid + 1, session, run);
}

describe("the fence's census", () => {
	it("proves a session fenced by its command's tree, whatever its presence says", () => {
		piWithCommand(100, ONE, "fenced");
		const census = fenceCensus(place([presence(ONE, 100, { fence: "none" })]));
		expect(census.rows.map((row) => row.judged)).toEqual(["proven"]);
		expect(censusHolds(census), "a census of proven sessions holds").toBe(true);
	});

	it("finds a command running unfenced, and fails the census", () => {
		piWithCommand(100, ONE, "unfenced");
		const census = fenceCensus(place([presence(ONE, 100, { fence: "fence" })]));
		expect(census.rows.map((row) => row.judged)).toEqual(["unfenced"]);
		expect(census.rows[0]?.why).toContain("sleep, pid 104");
		expect(censusHolds(census), "an unfenced command fails the census").toBe(
			false,
		);
	});

	it("judges neither the keeper's shell nor its tee, which run outside every fence", () => {
		piWithCommand(100, ONE, "fenced");
		const census = fenceCensus(place([presence(ONE, 100, { fence: "fence" })]));
		expect(census.rows.map((row) => row.judged)).toEqual(["proven"]);
	});

	it("leaves a process under a second old unjudged, as bubblewrap sets its flag once begun", () => {
		piWithCommand(100, ONE, "starting");
		const census = fenceCensus(place([presence(ONE, 100, { fence: "fence" })]));
		expect(census.rows.map((row) => row.judged)).toEqual(["unfenced"]);
		expect(
			census.rows[0]?.why,
			"judged by its environment, not the command",
		).toBe("its environment runs commands as they are");
	});

	it("proves nothing by NoNewPrivs alone, in the machine's own mounts", () => {
		lay({
			pid: 100,
			parent: 1,
			name: "node",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: { PI_SANDBOX: "fence" },
		});
		lay({
			pid: 102,
			parent: 100,
			name: "bash",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: { PI_BASH_KEEP: "/k" },
		});
		lay({
			pid: 103,
			parent: 102,
			name: "landrun",
			mounts: MACHINE,
			noNewPrivs: 1,
			env: {},
		});
		lay({
			pid: 104,
			parent: 103,
			name: "sleep",
			mounts: MACHINE,
			noNewPrivs: 1,
			env: {},
		});
		const census = fenceCensus(place([presence(ONE, 100, { fence: "fence" })]));
		expect(census.rows.map((row) => row.judged)).toEqual(["claimed"]);
	});

	it("leaves pi's own helpers, outside the fence by design, unjudged", () => {
		lay({
			pid: 100,
			parent: 1,
			name: "node",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: { PI_SANDBOX: "fence" },
		});
		lay({
			pid: 105,
			parent: 100,
			name: "language-server",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: {},
		});
		const census = fenceCensus(place([presence(ONE, 100, { fence: "fence" })]));
		expect(census.rows.map((row) => row.judged)).toEqual(["claimed"]);
	});

	it("judges an idle session by what its environment asks, and says where its claim differs", () => {
		lay({
			pid: 100,
			parent: 1,
			name: "node",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: { PI_SANDBOX: "strict" },
		});
		lay({
			pid: 200,
			parent: 1,
			name: "node",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: { PI_SANDBOX: "off" },
		});
		const census = fenceCensus(
			place([
				presence(ONE, 100, { fence: "none" }),
				presence(TWO, 200, { fence: "none" }),
			]),
		);
		expect(census.rows.map((row) => [row.judged, row.why])).toEqual([
			["claimed", "no command running; its environment asks strict"],
			["unfenced", "its environment runs commands as they are, PI_SANDBOX=off"],
		]);
		expect(census.rows[0]?.differs).toBe(
			"its presence says none, its environment asks strict",
		);
		expect(census.rows[1]?.differs).toBeUndefined();
	});

	it("reads an idle session as fenced when the stage lists it, as its pi would", () => {
		lay({
			pid: 100,
			parent: 1,
			name: "node",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: {},
			argv: ["node", "pi", "--session", `/logs/2026_${ONE}.jsonl`],
		});
		writeFileSync(join(stage, `${ONE}.json`), "{}");
		const census = fenceCensus(place([presence(ONE, 100, { fence: "fence" })]));
		expect(census.rows.map((row) => row.judged)).toEqual(["claimed"]);
	});

	it("leaves out a session whose owner has gone, restarted or is from another boot", () => {
		lay({
			pid: 100,
			parent: 1,
			name: "node",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: {},
			startTicks: 2000,
		});
		lay({
			pid: 300,
			parent: 1,
			name: "node",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: {},
		});
		const restarted = presence(ONE, 100);
		const gone = presence(TWO, 200);
		const lastBoot = presence("33333333-3333-4333-8333-333333333333", 300);
		const old = {
			...lastBoot,
			owner: { pid: 300, startedAt: 0, bootId: "another", startTicks: 1000 },
		};
		const census = fenceCensus(place([restarted, gone, old]));
		expect(census.rows).toEqual([]);
	});

	it("tells a host's sessions apart by the session each command names", () => {
		lay({
			pid: 500,
			parent: 1,
			name: "node",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: {},
		});
		lay({
			pid: 501,
			parent: 500,
			name: "pi-spawner",
			mounts: MACHINE,
			noNewPrivs: 0,
		});
		command(510, 501, ONE, "fenced");
		command(520, 501, TWO, "unfenced");
		const census = fenceCensus(
			place([
				presence(ONE, 500, { host: "work-background", fence: "fence" }),
				presence(TWO, 500, { host: "work-background", fence: "fence" }),
			]),
		);
		expect(census.rows.map((row) => row.judged)).toEqual([
			"proven",
			"unfenced",
		]);
	});

	it("says its counts first, then each session not proven, and leaves out the ownerless", () => {
		piWithCommand(100, ONE, "fenced");
		lay({
			pid: 200,
			parent: 1,
			name: "node",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: { PI_SANDBOX: "off" },
		});
		const ownerless = {
			...presence("44444444-4444-4444-8444-444444444444", 1),
		};
		const { owner: _, ...noOwner } = ownerless;
		const census = fenceCensus(
			place([
				presence(ONE, 100, { fence: "fence", quest: "QEST-1", title: "one" }),
				presence(TWO, 200, { fence: "none", quest: "QEST-2", title: "two" }),
				noOwner,
			]),
		);
		expect(censusText(census).split("\n")).toEqual([
			"2 live sessions: 1 proven fenced, 0 claimed, 1 unfenced",
			"unfenced  222222  QEST-2  two: its environment runs commands as they are, PI_SANDBOX=off",
			"1 presences name no owner, so they aren't counted",
			"",
		]);
	});

	it("fails, rather than finding no session, on a machine with no /proc", () => {
		rmSync(proc, { recursive: true });
		const census = fenceCensus(place([presence(ONE, 100)]));
		expect(census.rows).toEqual([]);
		expect(censusHolds(census), "an unread /proc fails the census").toBe(false);
		expect(censusText(census)).toContain("can't read");
	});
});

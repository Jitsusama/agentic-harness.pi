/**
 * The fence's census (lib/internal/fence/fence-census.ts), over a /proc of the
 * test's own: processes laid out as the bash tool and bubblewrap leave
 * them on a machine, as seen on optimus on 16 November. A fenced
 * command's tree ends in bubblewrap's child, with NoNewPrivs, mounts of
 * its own and a root where what the fence hides is gone; an unfenced
 * one ends in the machine's mounts without it; a session running
 * nothing is judged by what its environment asks, and by whether a
 * census saw its commands fenced in the last day.
 *
 * Long because every case lays its tree through the one set of fixtures
 * below, and a file split from it would carry them all again.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CensusPlace,
	censusHolds,
	censusText,
	fenceCensus,
	SIGHTING_LASTS_MS,
} from "../../../../lib/internal/fence/fence-census.ts";
import {
	GCLOUD_KEY,
	KEY_STAND_IN,
} from "../../../../lib/internal/fence/fence-gcloud-ssh.ts";
import { FENCE_HIDDEN } from "../../../../lib/internal/fence/fence-hidden.ts";
import { KEEPING_STUB } from "../../../../lib/internal/shell/kept.ts";
import type { Presence } from "../../../../lib/mesh/presence.ts";

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

/** The person's home and runtime folders, as every process sees them named. */
const HOME = "/home/someone";
const RUNTIME = "/run/user/1000";

/** Where the bash tool keeps its calls, and one call's path there. */
const KEPT = "/state/shell-workflow/kept";
const KEEP = `${KEPT}/one`;

/** The store's bash and tee, as the keeper's processes run them. */
const BASH = "/nix/store/0000-bash-interactive-5.3/bin/bash";
const TEE = "/nix/store/0000-coreutils-9.8/bin/tee";

/** When this census runs, in milliseconds. */
const NOW = Date.parse("2026-11-16T10:00:00Z");

/** Session ids, as pi mints them. */
const ONE = "11111111-1111-4111-8111-111111111111";
const TWO = "22222222-2222-4222-8222-222222222222";

/**
 * What a process's root holds: the fence's view, where secrets are gone
 * and only public keys stay in `~/.ssh`, or the machine's, where they
 * are all there.
 */
type View = "fenced" | "machine";

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
	readonly exe?: string;
	readonly root?: View;
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

/** Write `text` at `path` under a process's root, making its folders. */
function put(under: string, path: string, text: string): void {
	const at = join(under, path);
	mkdirSync(dirname(at), { recursive: true });
	writeFileSync(at, text);
}

/** Lay a process's root as the fence or the machine shows it. */
function layRoot(folder: string, view: View): void {
	const under = join(folder, "root");
	mkdirSync(join(under, RUNTIME), { recursive: true });
	put(under, `${HOME}/.ssh/config`, "Host *\n");
	put(under, `${HOME}/.ssh/id_ed25519.pub`, "ssh-ed25519 AAAA\n");
	put(under, `${HOME}/.config/gh/hosts.yml`, "github.com:\n  user: x\n");
	if (view === "machine") {
		put(under, `${HOME}/.ssh/id_ed25519`, "PRIVATE\n");
		put(under, `${RUNTIME}/bus`, "");
	}
}

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
	if (process.exe !== undefined) symlinkSync(process.exe, join(folder, "exe"));
	if (process.root !== undefined) layRoot(folder, process.root);
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
function place(
	presences: readonly Presence[],
	sightings: Readonly<Record<string, number>> = {},
): CensusPlace {
	return {
		proc,
		presences,
		stage,
		ticksPerSecond: HZ,
		home: HOME,
		runtimeDir: RUNTIME,
		kept: KEPT,
		sightings,
		now: NOW,
	};
}

/** How a command was laid: fenced by bubblewrap, run as it is, or begun. */
type Run = "fenced" | "unfenced" | "starting";

/** The keeper's shell for one call, as the bash tool starts it. */
function keeper(pid: number, parent: number, session: string): void {
	lay({
		pid,
		parent,
		name: "bash",
		mounts: MACHINE,
		noNewPrivs: 0,
		env: { PI_BASH_KEEP: KEEP, PI_SESSION_ID: session },
		argv: ["bash", "-c", KEEPING_STUB],
		exe: BASH,
	});
}

/**
 * The tee keeping a call's output, a fork of its keeper that ran tee:
 * the store's tee, or its coreutils whole, which runs as the program
 * its first word names, as on optimus.
 */
function tee(
	pid: number,
	parent: number,
	session: string,
	exe: string = TEE,
): void {
	lay({
		pid,
		parent,
		name: "tee",
		mounts: MACHINE,
		noNewPrivs: 0,
		env: { PI_BASH_KEEP: KEEP, PI_SESSION_ID: session },
		argv: ["tee", "-p", "-a", `${KEEP}.out`],
		exe,
	});
}

/**
 * One bash call, numbered from `pid`, as the bash tool's keeper leaves
 * it (lib/internal/shell/kept.ts): its shell and the tee keeping its
 * output, both outside any fence and carrying the keeper's variable,
 * and under the shell what it ran, which unsets that variable first:
 * bubblewrap's two processes and the command inside them when fenced,
 * the command alone when not, or a bubblewrap that has not yet set
 * NoNewPrivs when only just begun.
 */
function command(pid: number, parent: number, session: string, run: Run): void {
	const own = { PI_SESSION_ID: session };
	keeper(pid, parent, session);
	tee(pid + 1, pid, session);
	if (run === "unfenced") {
		lay({
			pid: pid + 2,
			parent: pid,
			name: "sleep",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: own,
			root: "machine",
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
			root: "machine",
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
		root: "machine",
	});
	lay({
		pid: pid + 3,
		parent: pid + 2,
		name: "bwrap",
		mounts: FENCED,
		noNewPrivs: 1,
		env: own,
		root: "fenced",
	});
	lay({
		pid: pid + 4,
		parent: pid + 3,
		name: "sleep",
		mounts: FENCED,
		noNewPrivs: 1,
		env: own,
		root: "fenced",
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

/**
 * A pi running no command, whose environment asks `sandbox`: a fleet's
 * subagent, the one pi that keeps `PI_SANDBOX=fence` (fence-lifted.ts).
 */
function idlePi(pid: number, sandbox: string): void {
	lay({
		pid,
		parent: 1,
		name: "node",
		mounts: MACHINE,
		noNewPrivs: 0,
		env: { PI_SANDBOX: sandbox, SUBAGENT_RUN_ID: "run-1" },
	});
}

describe("the fence's census", () => {
	it("proves a session fenced by its command's tree, whatever its presence says", () => {
		piWithCommand(100, ONE, "fenced");
		const census = fenceCensus(place([presence(ONE, 100, { fence: "none" })]));
		expect(census.rows.map((row) => row.judged)).toEqual(["proven"]);
		expect(censusHolds(census), "a census of proven sessions holds").toBe(true);
	});

	it("proves a session fenced that sees only the fence's stand-in for gcloud's key", () => {
		piWithCommand(100, ONE, "fenced");
		put(join(proc, "104/root"), `${HOME}/.ssh/${GCLOUD_KEY}`, KEY_STAND_IN);
		const census = fenceCensus(place([presence(ONE, 100, { fence: "fence" })]));
		expect(census.rows.map((row) => row.judged)).toEqual(["proven"]);
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

	it("leaves out the keeper's tee when the store's coreutils runs it as tee", () => {
		idlePi(100, "fence");
		keeper(102, 100, ONE);
		tee(103, 102, ONE, "/nix/store/0000-coreutils-full-9.12/bin/coreutils");
		const census = fenceCensus(place([presence(ONE, 100, { fence: "fence" })]));
		expect(census.rows.map((row) => row.judged)).toEqual(["claimed"]);
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

	it("counts unfenced NoNewPrivs alone, in the machine's own mounts", () => {
		idlePi(100, "fence");
		keeper(102, 100, ONE);
		lay({
			pid: 103,
			parent: 102,
			name: "landrun",
			mounts: MACHINE,
			noNewPrivs: 1,
			env: {},
			root: "machine",
		});
		lay({
			pid: 104,
			parent: 103,
			name: "sleep",
			mounts: MACHINE,
			noNewPrivs: 1,
			env: {},
			root: "machine",
		});
		const census = fenceCensus(place([presence(ONE, 100, { fence: "fence" })]));
		expect(census.rows.map((row) => [row.judged, row.why])).toEqual([
			[
				"unfenced",
				"a command can't be shown fenced: sleep, pid 104, it shares the machine's mounts",
			],
		]);
	});

	// Any command can give itself both marks, `unshare -rm setpriv
	// --no-new-privs` (ISXEG8, 75d72817), so a command is proven fenced
	// only where what the fence hides is gone from what it sees.
	it.each([
		["a private key in ~/.ssh", `${HOME}/.ssh/id_ed25519`, "PRIVATE\n"],
		["gcloud's own key", `${HOME}/.ssh/${GCLOUD_KEY}`, "PRIVATE\n"],
		["the session's bus", `${RUNTIME}/bus`, ""],
		["gh's token", `${HOME}/.config/gh/hosts.yml`, "oauth_token: gho_x\n"],
		[
			"a login the fence empties",
			`${HOME}/${FENCE_HIDDEN.home[0]}`,
			"PRIVATE\n",
		],
		[
			"a folder the fence empties",
			`${HOME}/.local/share/keyrings/login.keyring`,
			"PRIVATE\n",
		],
	])(
		"counts unfenced a command with both marks that still sees %s",
		(_, path, text) => {
			idlePi(100, "fence");
			keeper(102, 100, ONE);
			lay({
				pid: 103,
				parent: 102,
				name: "sleep",
				mounts: FENCED,
				noNewPrivs: 1,
				env: {},
				argv: ["sleep", "60"],
				root: "fenced",
			});
			put(join(proc, "103/root"), path, text);
			const census = fenceCensus(
				place([presence(ONE, 100, { fence: "fence" })]),
			);
			expect(census.rows.map((row) => [row.judged, row.why])).toEqual([
				[
					"unfenced",
					"a command sees what the fence hides: sleep, pid 103, " +
						`reads ${path}`,
				],
			]);
		},
	);

	it("counts unfenced a command with both marks whose root can't be read", () => {
		idlePi(100, "fence");
		keeper(102, 100, ONE);
		lay({
			pid: 103,
			parent: 102,
			name: "sleep",
			mounts: FENCED,
			noNewPrivs: 1,
			env: {},
		});
		const census = fenceCensus(place([presence(ONE, 100, { fence: "fence" })]));
		expect(census.rows.map((row) => [row.judged, row.why])).toEqual([
			[
				"unfenced",
				"a command can't be shown fenced: sleep, pid 103, its root can't be read",
			],
		]);
	});

	it("counts unfenced an end whose NoNewPrivs can't be read", () => {
		idlePi(100, "fence");
		keeper(102, 100, ONE);
		lay({
			pid: 103,
			parent: 102,
			name: "sleep",
			mounts: FENCED,
			env: {},
			root: "fenced",
		});
		const census = fenceCensus(place([presence(ONE, 100, { fence: "fence" })]));
		expect(census.rows.map((row) => [row.judged, row.why])).toEqual([
			[
				"unfenced",
				"a command can't be shown fenced: sleep, pid 103, its NoNewPrivs can't be read",
			],
		]);
	});

	// The keeper's variable is one any command can set itself, so it never
	// leaves a process out (ISXEG8, 75d72817): only the keeper's own shell
	// and tee, by what they run, are outside the fence by design.
	it("judges a process carrying the keeper's variable that isn't the keeper or its tee", () => {
		idlePi(100, "fence");
		keeper(102, 100, ONE);
		lay({
			pid: 103,
			parent: 102,
			name: "cat",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: { PI_BASH_KEEP: KEEP },
			exe: "/nix/store/0000-coreutils-9.8/bin/cat",
			root: "machine",
		});
		lay({
			pid: 104,
			parent: 102,
			name: "tee",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: { PI_BASH_KEEP: KEEP },
			argv: ["tee", "-p", "-a", "/home/someone/elsewhere"],
			exe: TEE,
			root: "machine",
		});
		const census = fenceCensus(place([presence(ONE, 100, { fence: "fence" })]));
		expect(census.rows.map((row) => [row.judged, row.why])).toEqual([
			["unfenced", "a command runs unfenced: cat, pid 103"],
		]);
	});

	it("judges a shell claiming to keep a call when it isn't the store's bash running the stub", () => {
		idlePi(100, "fence");
		lay({
			pid: 102,
			parent: 100,
			name: "bash",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: { PI_BASH_KEEP: KEEP },
			argv: ["bash", "-c", "while read line; do :; done < ~/.ssh/id_ed25519"],
			exe: BASH,
			root: "machine",
		});
		lay({
			pid: 103,
			parent: 100,
			name: "bash",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: { PI_BASH_KEEP: KEEP },
			argv: ["bash", "-c", KEEPING_STUB],
			exe: "/home/someone/bash",
			root: "machine",
		});
		const census = fenceCensus(place([presence(ONE, 100, { fence: "fence" })]));
		expect(census.rows[0]?.judged).toBe("unfenced");
		expect(census.rows[0]?.why).toBe("a command runs unfenced: bash, pid 102");
	});

	it("judges a keeper's fork running the command's own builtins", () => {
		idlePi(100, "fence");
		keeper(102, 100, ONE);
		tee(103, 102, ONE);
		keeper(104, 102, ONE);
		const census = fenceCensus(place([presence(ONE, 100, { fence: "fence" })]));
		expect(census.rows[0]?.why).toBe("a command runs unfenced: bash, pid 104");
	});

	it("leaves pi's own helpers, outside the fence by design, unjudged", () => {
		idlePi(100, "fence");
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
		idlePi(100, "strict");
		idlePi(200, "off");
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

	// A pi lifts PI_SANDBOX=fence from itself unless it is a subagent
	// (fence-lifted.ts), and /proc still shows what it was started with: on
	// 16 November a pi started so ran its sleep unfenced.
	it("reads an idle session's PI_SANDBOX=fence as its pi does, lifted unless a subagent's", () => {
		lay({
			pid: 100,
			parent: 1,
			name: "node",
			mounts: MACHINE,
			noNewPrivs: 0,
			env: { PI_SANDBOX: "fence" },
		});
		idlePi(200, "fence");
		const census = fenceCensus(
			place([
				presence(ONE, 100, { fence: "none" }),
				presence(TWO, 200, { fence: "fence" }),
			]),
		);
		expect(census.rows.map((row) => [row.judged, row.why])).toEqual([
			[
				"unfenced",
				"its environment runs commands as they are, PI_SANDBOX=fence lifted",
			],
			["claimed", "no command running; its environment asks fence"],
		]);
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

	// A claim says what the next command would ask for, never that the
	// fence lays: a claimed session holds only once a census has seen its
	// commands fenced in the last day (ISXEG8, 75d72817).
	describe("what a census saw before", () => {
		it("keeps when each session was last seen proven", () => {
			piWithCommand(100, ONE, "fenced");
			const census = fenceCensus(
				place([presence(ONE, 100)], { [TWO]: NOW - 1000 }),
			);
			expect(census.sightings).toEqual({ [ONE]: NOW, [TWO]: NOW - 1000 });
		});

		it("lets go of a sighting older than a day", () => {
			piWithCommand(100, ONE, "fenced");
			const census = fenceCensus(
				place([presence(ONE, 100)], { [TWO]: NOW - SIGHTING_LASTS_MS - 1 }),
			);
			expect(census.sightings).toEqual({ [ONE]: NOW });
		});

		it("holds a claimed session seen fenced in the last day", () => {
			idlePi(100, "fence");
			const census = fenceCensus(
				place([presence(ONE, 100)], { [ONE]: NOW - SIGHTING_LASTS_MS + 1 }),
			);
			expect(censusHolds(census), "a claim seen fenced holds").toBe(true);
			expect(censusText(census).split("\n")[1]).toBe(
				"claimed  111111: no command running; its environment asks fence; " +
					"seen fenced 23 hours ago",
			);
		});

		it("fails a claimed session no census has seen fenced in the last day", () => {
			idlePi(100, "fence");
			const census = fenceCensus(
				place([presence(ONE, 100)], { [ONE]: NOW - SIGHTING_LASTS_MS - 1 }),
			);
			expect(censusHolds(census), "a claim never seen fenced fails").toBe(
				false,
			);
			expect(censusText(census).split("\n")[1]).toBe(
				"claimed  111111: no command running; its environment asks fence; " +
					"not seen fenced in the last 24 hours",
			);
		});
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
		idlePi(200, "off");
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
			"1 presence names no owner, so it isn't counted",
			"",
		]);
	});

	it("says one live session as one", () => {
		piWithCommand(100, ONE, "fenced");
		const census = fenceCensus(place([presence(ONE, 100)]));
		expect(censusText(census)).toBe(
			"1 live session: 1 proven fenced, 0 claimed, 0 unfenced\n",
		);
	});

	it("fails, rather than passing, when it finds no live session", () => {
		const census = fenceCensus(place([]));
		expect(census.read, "the processes were read").toBe(true);
		expect(censusHolds(census), "a census of nobody fails").toBe(false);
		expect(censusText(census)).toBe(
			"0 live sessions: 0 proven fenced, 0 claimed, 0 unfenced\n",
		);
	});

	it("fails, rather than finding no session, on a machine with no /proc", () => {
		rmSync(proc, { recursive: true });
		const census = fenceCensus(place([presence(ONE, 100)]));
		expect(census.rows).toEqual([]);
		expect(censusHolds(census), "an unread /proc fails the census").toBe(false);
		expect(censusText(census)).toContain("can't read");
	});
});

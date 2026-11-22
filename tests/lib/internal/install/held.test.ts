/**
 * A running pi keeps its own install out of the Nix store's collection:
 * its store paths are rooted for as long as it runs, and a root whose
 * process is gone is swept at the next start.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addRootWithNixStore,
	type Held,
	heldNote,
	holdInstall,
	type NoteScreen,
	sayHeldOnce,
	startOf,
	storePathsOf,
	sweepHeld,
} from "../../../../lib/internal/install/held.ts";

const NODE = "/nix/store/giny1jiaincprw0hqamggl5zz0230fbx-nodejs-22.23.5";
const PI = "/nix/store/ga0asmh9p68yjj9ibl45fdc92s4d40fi-pi-coding-agent-1.5.0";

let folder: string;

beforeEach(() => {
	folder = join(mkdtempSync(join(tmpdir(), "held-")), "roots");
});

afterEach(() => {
	rmSync(join(folder, ".."), { recursive: true, force: true });
});

describe("storePathsOf", () => {
	it("names each store path a running pi's files lie in, once", () => {
		expect(
			storePathsOf([
				`${NODE}/bin/node`,
				`${PI}/lib/node_modules/pi-monorepo/packages/coding-agent/dist/cli.js`,
				`${PI}/lib/node_modules/pi-monorepo`,
				"/home/someone/.local/share/pi-packages/current/index.ts",
			]),
		).toEqual([NODE, PI]);
	});
});

describe("holdInstall", () => {
	it("roots each store path under a name for the process and its start, sweeping the gone first", async () => {
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, "7-100-0"), "");
		const added: [string, string][] = [];
		const held = await holdInstall(
			[`${NODE}/bin/node`, `${PI}/cli.js`],
			folder,
			{ pid: 41, started: "900" },
			async (link, storePath) => {
				added.push([link, storePath]);
			},
			() => undefined,
		);
		expect(held).toEqual({
			links: [join(folder, "41-900-0"), join(folder, "41-900-1")],
			missed: [],
		});
		expect(heldNote(held)).toBeUndefined();
		expect(
			existsSync(join(folder, "7-100-0")),
			"a gone pi's root is swept",
		).toBe(false);
		expect(added).toEqual([
			[join(folder, "41-900-0"), NODE],
			[join(folder, "41-900-1"), PI],
		]);
	});

	it("roots nothing, and makes no folder, for an install outside the store", async () => {
		const held = await holdInstall(
			["/usr/local/bin/node", "/opt/pi/cli.js"],
			folder,
			{ pid: 41, started: "900" },
			async () => {
				throw new Error("asked to root a path outside the store");
			},
		);
		expect(held).toEqual({ links: [], missed: [] });
		expect(existsSync(folder), "no folder for nothing held").toBe(false);
	});

	it("names a store path it couldn't root, and still roots the rest", async () => {
		const held = await holdInstall(
			[`${NODE}/bin/node`, `${PI}/cli.js`],
			folder,
			{ pid: 41, started: "900" },
			async (_link, storePath) => {
				if (storePath === NODE) throw new Error("the daemon said no");
			},
			() => undefined,
		);
		expect(held).toEqual({
			links: [join(folder, "41-900-1")],
			missed: [`${NODE}: the daemon said no`],
		});
		expect(heldNote(held)).toContain(
			`subagents and councils would fail until it restarts: ${NODE}: the daemon said no`,
		);
	});
});

describe("sayHeldOnce", () => {
	const missed: Held = { links: [], missed: [`${NODE}: the daemon said no`] };

	/** A screen that notes what it was told. */
	function screen(told: string[]): NoteScreen {
		return { hasUI: true, ui: { notify: (note) => told.push(note) } };
	}

	/** A replaced session's context, which throws on every read. */
	const replaced: NoteScreen = {
		get hasUI(): boolean {
			throw new Error("This extension ctx is stale after session replacement");
		},
		get ui(): NoteScreen["ui"] {
			throw new Error("This extension ctx is stale after session replacement");
		},
	};

	it("says a missed hold once in a process, however many sessions start", async () => {
		const once = { said: false };
		const told: string[] = [];
		await sayHeldOnce(Promise.resolve(missed), screen(told), once);
		await sayHeldOnce(Promise.resolve(missed), screen(told), once);
		expect(told).toEqual([heldNote(missed)]);
	});

	it("says nothing, and fails nothing, in a session replaced before its hold resolved, leaving it for the next", async () => {
		const once = { said: false };
		await expect(
			sayHeldOnce(Promise.resolve(missed), replaced, once),
		).resolves.toBeUndefined();
		const told: string[] = [];
		await sayHeldOnce(Promise.resolve(missed), screen(told), once);
		expect(told).toEqual([heldNote(missed)]);
	});

	it("says nothing for a hold that missed nothing", async () => {
		const told: string[] = [];
		await sayHeldOnce(
			Promise.resolve({ links: [], missed: [] }),
			screen(told),
			{ said: false },
		);
		expect(told).toEqual([]);
	});
});

describe("sweepHeld", () => {
	it("removes the roots of processes gone or started again since, keeping the live", () => {
		mkdirSync(folder, { recursive: true });
		for (const name of ["10-500-0", "10-500-1", "11-600-0", "12-700-0"])
			writeFileSync(join(folder, name), "");
		const live = new Map([
			[10, "500"],
			[11, "601"],
		]);
		const removed = sweepHeld(folder, (pid) => live.get(pid));
		expect(removed.sort()).toEqual(["11-600-0", "12-700-0"]);
		expect(readdirSync(folder).sort()).toEqual(["10-500-0", "10-500-1"]);
	});

	it("leaves alone any name it didn't write, such as a link nix-store is still making", () => {
		mkdirSync(folder, { recursive: true });
		for (const name of ["12-700-0.tmp-3-1", "notes", "12-700"])
			writeFileSync(join(folder, name), "");
		expect(sweepHeld(folder, () => undefined)).toEqual([]);
		expect(readdirSync(folder).sort()).toEqual([
			"12-700",
			"12-700-0.tmp-3-1",
			"notes",
		]);
	});

	it("reads a process that isn't there as gone", () => {
		const child = spawnSync("true");
		expect(startOf(child.pid ?? 0)).toBeUndefined();
	});

	it("reads this process's own start as live", () => {
		const started = startOf(process.pid);
		expect(started, "this process has a start").toBeDefined();
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, `${process.pid}-${started}-0`), "");
		expect(sweepHeld(folder)).toEqual([]);
	});
});

const nixStore = spawnSync("nix-store", ["--version"]).status === 0;

describe.skipIf(!nixStore)("a collection after a switch", () => {
	it("keeps a running pi's install, and takes it once nothing holds it", async () => {
		// A store path nothing roots, as an old install is after a switch.
		const source = join(folder, "..", `pi-held-${randomUUID()}`);
		writeFileSync(source, randomUUID());
		const added = spawnSync("nix-store", ["--add", source], {
			encoding: "utf8",
		});
		// A store this user can't add to can't show a collection either.
		if (added.status !== 0) return;
		const storePath = added.stdout.trim();
		const collect = () =>
			spawnSync("nix-store", ["--delete", storePath], { encoding: "utf8" });
		try {
			const {
				links: [link],
				missed,
			} = await holdInstall(
				[storePath],
				folder,
				{ pid: process.pid, started: startOf(process.pid) ?? "0" },
				addRootWithNixStore,
			);
			expect(missed).toEqual([]);
			const held = collect();
			expect(held.status, held.stderr).not.toBe(0);
			expect(existsSync(storePath), "a held install survives").toBe(true);
			rmSync(link ?? "", { force: true });
			const freed = collect();
			expect(freed.status, freed.stderr).toBe(0);
			expect(existsSync(storePath), "a freed install is taken").toBe(false);
		} finally {
			rmSync(join(folder), { recursive: true, force: true });
			collect();
		}
		// Each collection reads every root on the machine: tens of seconds.
	}, 300_000);
});

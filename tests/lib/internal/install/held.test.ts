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
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addRootWithNixStore,
	faultsInto,
	HELD_SAID,
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

	/** pi's words for a replaced context, as its extension runner throws them. */
	const STALE =
		"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession()";

	/** A screen that notes what it was told. */
	function screen(told: string[]): NoteScreen {
		return { hasUI: true, ui: { notify: (note) => told.push(note) } };
	}

	/**
	 * A session's context that is live until `replace` is called, as pi's
	 * is at session start, and throws on every read once it is replaced.
	 */
	function session(): { ctx: NoteScreen; replace: () => void } {
		let stale = false;
		const live = (): void => {
			if (stale) throw new Error(STALE);
		};
		return {
			ctx: {
				get hasUI(): boolean {
					live();
					return true;
				},
				get ui(): NoteScreen["ui"] {
					live();
					return { notify: () => live() };
				},
			},
			replace: () => {
				stale = true;
			},
		};
	}

	afterEach(() => {
		Reflect.deleteProperty(globalThis, Symbol.for(HELD_SAID));
	});

	it("says a missed hold once in a process, however many sessions start", async () => {
		const told: string[] = [];
		await sayHeldOnce(Promise.resolve(missed), screen(told));
		await sayHeldOnce(Promise.resolve(missed), screen(told));
		expect(told).toEqual([heldNote(missed)]);
	});

	it("says nothing, and fails nothing, in a session replaced while its hold ran, leaving it for the next", async () => {
		const once = { said: false };
		const faults: unknown[] = [];
		let resolve: (held: Held) => void = () => undefined;
		const held = new Promise<Held>((settle) => {
			resolve = settle;
		});
		const first = session();
		const saying = sayHeldOnce(held, first.ctx, {
			once,
			fault: (error) => faults.push(error),
		});
		first.replace();
		resolve(missed);
		await expect(saying).resolves.toBeUndefined();
		const told: string[] = [];
		await sayHeldOnce(held, screen(told), { once });
		expect(told).toEqual([heldNote(missed)]);
		expect(faults, "a replacement is no fault").toEqual([]);
	});

	it("leaves the note for the next session when telling the screen fails after it said it had one", async () => {
		const once = { said: false };
		const faults: unknown[] = [];
		const broken: NoteScreen = {
			hasUI: true,
			ui: {
				notify: () => {
					throw new Error("the screen is gone");
				},
			},
		};
		await expect(
			sayHeldOnce(Promise.resolve(missed), broken, {
				once,
				fault: (error) => faults.push(error),
			}),
		).resolves.toBeUndefined();
		const told: string[] = [];
		await sayHeldOnce(Promise.resolve(missed), screen(told), { once });
		expect(told).toEqual([heldNote(missed)]);
		expect(faults.map(String)).toEqual(["Error: the screen is gone"]);
	});

	it("leaves the note for a session with a screen when one without starts first", async () => {
		const once = { said: false };
		const headless: string[] = [];
		const told: string[] = [];
		await sayHeldOnce(
			Promise.resolve(missed),
			{ hasUI: false, ui: { notify: (note) => headless.push(note) } },
			{ once },
		);
		await sayHeldOnce(Promise.resolve(missed), screen(told), { once });
		expect(headless).toEqual([]);
		expect(told).toEqual([heldNote(missed)]);
	});

	it("tells a hold that failed as a fault, never rejecting", async () => {
		const faults: unknown[] = [];
		const told: string[] = [];
		await expect(
			sayHeldOnce(Promise.reject(new Error("no hold")), screen(told), {
				once: { said: false },
				fault: (error) => faults.push(error),
			}),
		).resolves.toBeUndefined();
		expect(faults.map(String)).toEqual(["Error: no hold"]);
		expect(told).toEqual([]);
	});

	it("keeps a note another session said when this one's hold fails, so it is never said twice", async () => {
		const once = { said: true };
		await sayHeldOnce(Promise.reject(new Error("no hold")), screen([]), {
			once,
		});
		const told: string[] = [];
		await sayHeldOnce(Promise.resolve(missed), screen(told), { once });
		expect(told, "said once already, by another session").toEqual([]);
	});

	it("never rejects when telling its fault fails too", async () => {
		await expect(
			sayHeldOnce(Promise.reject(new Error("no hold")), screen([]), {
				once: { said: false },
				fault: () => {
					throw new Error("no log");
				},
			}),
		).resolves.toBeUndefined();
	});

	it("never rejects for an error whose message can't be read", async () => {
		const odd = new Error("odd");
		Object.defineProperty(odd, "message", {
			get() {
				throw new Error("unreadable");
			},
		});
		await expect(
			sayHeldOnce(Promise.reject(odd), screen([]), { once: { said: false } }),
		).resolves.toBeUndefined();
	});

	it("says nothing for a hold that missed nothing", async () => {
		const told: string[] = [];
		await sayHeldOnce(
			Promise.resolve({ links: [], missed: [] }),
			screen(told),
			{ once: { said: false } },
		);
		expect(told).toEqual([]);
	});
});

describe("faultsInto", () => {
	it("keeps each fault as a line in its log, making the folder", () => {
		const log = join(folder, "deeper", "faults.jsonl");
		const fault = faultsInto(log);
		fault(new Error("the screen is gone"));
		fault("plain");
		const lines = readFileSync(log, "utf8").trim().split("\n");
		expect(lines.map((line) => JSON.parse(line).why)).toEqual([
			expect.stringContaining("Error: the screen is gone"),
			"plain",
		]);
	});

	it("throws nothing for a fault that can't be put into words", () => {
		const log = join(folder, "faults.jsonl");
		const unsayable = {
			toString(): string {
				throw new Error("no words");
			},
		};
		expect(() => faultsInto(log)(unsayable)).not.toThrow();
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

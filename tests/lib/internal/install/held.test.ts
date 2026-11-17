/**
 * A running pi keeps its own install out of the Nix store's collection:
 * its store paths are rooted for as long as it runs, and a root whose
 * process is gone is swept at the next start.
 */

import { execFileSync, spawnSync } from "node:child_process";
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
	holdInstall,
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
	it("roots each store path under a name for the process and its start", async () => {
		const added: [string, string][] = [];
		const links = await holdInstall(
			[`${NODE}/bin/node`, `${PI}/cli.js`],
			folder,
			{ pid: 41, started: "900" },
			async (link, storePath) => {
				added.push([link, storePath]);
			},
			() => undefined,
		);
		expect(links).toEqual([join(folder, "41-900-0"), join(folder, "41-900-1")]);
		expect(added).toEqual([
			[join(folder, "41-900-0"), NODE],
			[join(folder, "41-900-1"), PI],
		]);
	});

	it("roots nothing, and makes no folder, for an install outside the store", async () => {
		const links = await holdInstall(
			["/usr/local/bin/node", "/opt/pi/cli.js"],
			folder,
			{ pid: 41, started: "900" },
			async () => {
				throw new Error("asked to root a path outside the store");
			},
		);
		expect(links).toEqual([]);
		expect(existsSync(folder), "no folder for nothing held").toBe(false);
	});

	it("names the store path it couldn't root", async () => {
		await expect(
			holdInstall(
				[`${PI}/cli.js`],
				folder,
				{ pid: 41, started: "900" },
				async () => {
					throw new Error("the daemon said no");
				},
				() => undefined,
			),
		).rejects.toThrow(
			`${PI} can't be kept from collection: the daemon said no`,
		);
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
		const storePath = execFileSync("nix-store", ["--add", source], {
			encoding: "utf8",
		}).trim();
		const collect = () =>
			spawnSync("nix-store", ["--delete", storePath], { encoding: "utf8" });
		try {
			const [link] = await holdInstall(
				[storePath],
				folder,
				{ pid: process.pid, started: startOf(process.pid) ?? "0" },
				addRootWithNixStore,
			);
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

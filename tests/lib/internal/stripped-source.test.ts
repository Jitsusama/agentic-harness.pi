/**
 * The stripped-source cache: a module node 22 would strip is read back
 * as node stripped it, with no call to node's own load, which is where
 * node loads its transpiler. In a node of its own:
 * stripped-source-node.test.ts.
 */

import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import type { LoadFnOutput, LoadHookContext } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cacheRoot,
	entryWriter,
	installKey,
	OFF_VARIABLE,
	type ProcessFacts,
	startStrippedSourceCache,
	strippedSourceLoad,
	sweepGone,
	whyNot,
} from "../../../lib/internal/stripped-source.mjs";

/** What node gives a load hook, which this one passes on as it is. */
const CONTEXT: LoadHookContext = {
	conditions: [],
	format: undefined,
	importAttributes: {},
};

const URL_A = "file:///install/host/a.ts";

let root: string;
beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "stripped-source-")));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** A process node 22 strips types in, as the cache serves. */
const STRIPPING = {
	env: {},
	version: "v22.23.5",
	typescript: "strip",
	sourceMaps: false,
} as const;

/** A hook over files held in `files`, and what it called. */
function hookOver(files: Map<string, string>, format = "module-typescript") {
	const kept: [string, string][] = [];
	const read = vi.fn((path: string) => {
		const text = files.get(path);
		if (text === undefined) throw new Error(`ENOENT: ${path}`);
		return text;
	});
	const strip = vi.fn((source: string, url: string) => `js(${source})@${url}`);
	const nextLoad = vi.fn(
		(_url: string): LoadFnOutput => ({ format, source: "raw" }),
	);
	const load = strippedSourceLoad({
		folder: "/cache",
		read,
		strip,
		keep: (file, text) => kept.push([file, text]),
	});
	return { load, read, strip, nextLoad, kept };
}

describe("strippedSourceLoad", () => {
	it("strips a module node didn't have kept and keeps it, then serves it with no load of node's", () => {
		const files = new Map([[fileURLToPath(URL_A), "const a: number = 1;"]]);
		const first = hookOver(files);

		expect(first.load(URL_A, CONTEXT, first.nextLoad)).toEqual({
			format: "module",
			source: `js(const a: number = 1;)@${URL_A}`,
			shortCircuit: true,
		});
		expect(first.strip).toHaveBeenCalledWith("const a: number = 1;", URL_A);
		expect(first.kept).toHaveLength(1);
		const [file, text] = first.kept[0] ?? ["", ""];
		expect(file.startsWith("/cache/")).toBe(true);
		expect(text).toBe(`module\njs(const a: number = 1;)@${URL_A}`);

		files.set(file, text);
		const second = hookOver(files);
		expect(second.load(URL_A, CONTEXT, second.nextLoad)).toEqual({
			format: "module",
			source: `js(const a: number = 1;)@${URL_A}`,
			shortCircuit: true,
		});
		expect(second.nextLoad, "node's load loads its stripper").not.toBeCalled();
		expect(second.strip).not.toBeCalled();
		expect(second.kept).toEqual([]);
	});

	it("keeps a module apart by its source and by its URL", () => {
		const files = new Map([
			[fileURLToPath(URL_A), "one"],
			["/install/host/b.ts", "one"],
		]);
		const { load, nextLoad, kept } = hookOver(files);
		load(URL_A, CONTEXT, nextLoad);
		files.set(fileURLToPath(URL_A), "two");
		load(URL_A, CONTEXT, nextLoad);
		load("file:///install/host/b.ts", CONTEXT, nextLoad);

		const names = kept.map(([file]) => file);
		expect(new Set(names).size, names.join(" ")).toBe(3);
	});

	it("leaves to node what it would strip as CommonJS, and keeps none of it", () => {
		const files = new Map([[fileURLToPath(URL_A), "export {};"]]);
		const { load, nextLoad, kept, strip } = hookOver(
			files,
			"commonjs-typescript",
		);
		expect(load(URL_A, CONTEXT, nextLoad)).toEqual({
			format: "commonjs-typescript",
			source: "raw",
		});
		expect(strip).not.toBeCalled();
		expect(kept).toEqual([]);
	});

	it("leaves to node every module that isn't a TypeScript file, reading none", () => {
		const { load, nextLoad, read } = hookOver(new Map());
		for (const url of [
			"file:///install/a.mjs",
			"file:///install/a.cts",
			"node:fs",
			"data:text/javascript,export {}",
		])
			load(url, CONTEXT, nextLoad);
		expect(nextLoad).toHaveBeenCalledTimes(4);
		expect(read).not.toBeCalled();
	});

	it("reads an entry cut short as one not kept", () => {
		const files = new Map([[fileURLToPath(URL_A), "x"]]);
		const first = hookOver(files);
		first.load(URL_A, CONTEXT, first.nextLoad);
		const [file] = first.kept[0] ?? [""];
		for (const cut of ["", "module", "modu", "commonjs\nx"]) {
			files.set(file, cut);
			const again = hookOver(files);
			again.load(URL_A, CONTEXT, again.nextLoad);
			expect(again.nextLoad, JSON.stringify(cut)).toHaveBeenCalledOnce();
		}
	});
});

describe("whyNot", () => {
	it("serves node 22 stripping types", () => {
		expect(whyNot(STRIPPING)).toBeUndefined();
	});

	it("stands aside when turned off, on another node, or where node's own strip differs", () => {
		const cases: Record<string, ProcessFacts> = {
			off: { ...STRIPPING, env: { [OFF_VARIABLE]: "off" } },
			"node 24": { ...STRIPPING, version: "v24.22.3" },
			"node 23": { ...STRIPPING, version: "v23.0.0" },
			transforming: { ...STRIPPING, typescript: "transform" },
			"no TypeScript": { ...STRIPPING, typescript: false },
			"source maps": { ...STRIPPING, sourceMaps: true },
		};
		for (const [name, facts] of Object.entries(cases))
			expect(whyNot(facts), name).toBeTypeOf("string");
		expect(
			whyNot({ ...STRIPPING, env: { [OFF_VARIABLE]: "on" } }),
		).toBeUndefined();
	});
});

describe("where entries lie", () => {
	it("lies in pi's state, an absolute XDG_STATE_HOME's or the home's", () => {
		const tail = join("pi", "agentic-harness.pi", "stripped-source");
		expect(cacheRoot({ XDG_STATE_HOME: "/state" }, "/home/u")).toBe(
			join("/state", tail),
		);
		expect(cacheRoot({ XDG_STATE_HOME: "rel" }, "/home/u")).toBe(
			join("/home/u", ".local", "state", tail),
		);
		expect(cacheRoot({}, "/home/u")).toBe(
			join("/home/u", ".local", "state", tail),
		);
	});

	it("names an install's folder by its path and node's version", () => {
		const one = installKey("/install/one", "v22.23.5");
		expect(one).toMatch(/^[0-9a-f]{16}$/);
		expect(installKey("/install/two", "v22.23.5")).not.toBe(one);
		expect(installKey("/install/one", "v22.23.6")).not.toBe(one);
	});
});

describe("entryWriter", () => {
	it("writes each entry and the install it serves, owner-only", async () => {
		const folder = join(root, "cache", "key");
		const keep = entryWriter(folder, "/install/one");
		keep(join(folder, "e1"), "module\none");
		keep(join(folder, "e2"), "module\ntwo");

		await vi.waitFor(async () => {
			expect((await readdir(folder)).sort()).toEqual(["e1", "e2", "root"]);
		});
		expect(await readFile(join(folder, "e2"), "utf8")).toBe("module\ntwo");
		expect(await readFile(join(folder, "root"), "utf8")).toBe("/install/one");
		expect((await stat(folder)).mode & 0o777).toBe(0o700);
		expect((await stat(join(folder, "e1"))).mode & 0o777).toBe(0o600);
	});

	it("loses nothing but the entry where it can't write", async () => {
		const blocked = join(root, "file");
		await writeFile(blocked, "");
		const keep = entryWriter(join(blocked, "key"), "/install/one");
		keep(join(blocked, "key", "e1"), "module\none");
		await new Promise((settle) => setTimeout(settle, 50));
		expect(await readdir(root)).toEqual(["file"]);
	});
});

describe("sweepGone", () => {
	it("removes the folders of installs gone from the disk, and those naming none an hour on", async () => {
		const live = join(root, "live-install");
		await mkdir(live);
		const folder = async (name: string, served?: string) => {
			await mkdir(join(root, name));
			if (served !== undefined)
				await writeFile(join(root, name, "root"), served);
		};
		await folder("mine");
		await folder("live", live);
		await folder("gone", join(root, "no-such-install"));
		await folder("fresh");
		await folder("stale");
		const hourAgo = (Date.now() - 61 * 60 * 1000) / 1000;
		await utimes(join(root, "stale"), hourAgo, hourAgo);

		await sweepGone(root, "mine");

		expect((await readdir(root)).sort()).toEqual([
			"fresh",
			"live",
			"live-install",
			"mine",
		]);
	});

	it("keeps its own folder though it names a gone install", async () => {
		await mkdir(join(root, "mine"));
		await writeFile(join(root, "mine", "root"), join(root, "gone"));
		await sweepGone(root, "mine");
		expect(await readdir(root)).toEqual(["mine"]);
	});

	it("sweeps nothing where nothing was kept", async () => {
		await expect(sweepGone(join(root, "none"), "mine")).resolves.toBe(
			undefined,
		);
	});
});

describe("startStrippedSourceCache", () => {
	it("registers its hook where node 22 strips, keeping in the install's folder", () => {
		const register = vi.fn();
		const started = startStrippedSourceCache({
			env: { XDG_STATE_HOME: root },
			home: "/home/u",
			packageRoot: "/install/one",
			facts: STRIPPING,
			register,
		});
		expect(started).toEqual({
			state: "on",
			folder: join(
				cacheRoot({ XDG_STATE_HOME: root }, "/home/u"),
				installKey("/install/one", "v22.23.5"),
			),
		});
		expect(register).toHaveBeenCalledWith({ load: expect.any(Function) });
	});

	it("registers nothing where it stands aside", () => {
		const register = vi.fn();
		const started = startStrippedSourceCache({
			facts: { ...STRIPPING, version: "v24.22.3" },
			register,
		});
		expect(started.state).toBe("off");
		expect(register).not.toBeCalled();
	});

	it("answers why it failed rather than throwing, leaving node to strip", () => {
		const started = startStrippedSourceCache({
			packageRoot: "/install/one",
			facts: STRIPPING,
			register: () => {
				throw new Error("no hooks here");
			},
		});
		expect(started).toEqual({ state: "failed", reason: "no hooks here" });
	});
});

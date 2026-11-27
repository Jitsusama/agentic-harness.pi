/**
 * The stripped-source cache: a module node 22 would strip is read back
 * as node stripped it, with no call to node's own load, which is where
 * node loads its transpiler. In a node of its own:
 * stripped-source-node.test.ts.
 */

import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
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
	entryText,
	entryWriter,
	heldState,
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
	hooks: true,
} as const;

/** A hook over files held in `files`, and what it called. */
function hookOver(
	files: Map<string, string>,
	format = "module-typescript",
	trusted = true,
) {
	const kept: [string, string][] = [];
	const touched: string[] = [];
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
		within: "file:///install/",
		read,
		strip,
		keep: (file, text) => kept.push([file, text]),
		trusted: () => trusted,
		touch: (file) => touched.push(file),
	});
	return { load, read, strip, nextLoad, kept, touched };
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
		expect(file, "the entry is kept under the cache folder").toMatch(
			/^\/cache\//,
		);
		expect(text).toBe(entryText(`js(const a: number = 1;)@${URL_A}`));
		expect(text).toMatch(/^module bare [0-9a-f]{64}\n/);

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
		expect(second.touched).toEqual([file]);
	});

	it("reads no entry from a folder it may not trust, leaving node to strip", () => {
		const files = new Map([[fileURLToPath(URL_A), "x"]]);
		const first = hookOver(files);
		first.load(URL_A, CONTEXT, first.nextLoad);
		const [file, text] = first.kept[0] ?? ["", ""];
		files.set(file, text);
		const untrusted = hookOver(files, "module-typescript", false);
		untrusted.load(URL_A, CONTEXT, untrusted.nextLoad);
		expect(untrusted.read).not.toHaveBeenCalledWith(file);
		expect(untrusted.nextLoad).toHaveBeenCalledOnce();
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

	it("leaves to node, as node loads it, every module that isn't the package's own TypeScript, reading none", () => {
		const { load, nextLoad, read } = hookOver(new Map());
		const urls = [
			"file:///install/a.mjs",
			"file:///install/a.cts",
			"file:///elsewhere/a.ts",
			"file:///install/node_modules/dep/a.ts",
			"file:///install/host/node_modules/dep/a.mts",
			"node:fs",
			"data:text/javascript,export {}",
		];
		for (const url of urls)
			expect(load(url, CONTEXT, nextLoad), url).toEqual({
				format: "module-typescript",
				source: "raw",
			});
		expect(nextLoad.mock.calls.map(([url]) => url)).toEqual(urls);
		expect(read).not.toBeCalled();
	});

	it("reads an entry cut short, damaged or kept with its comments as one not kept", () => {
		const files = new Map([[fileURLToPath(URL_A), "x"]]);
		const first = hookOver(files);
		first.load(URL_A, CONTEXT, first.nextLoad);
		const [file, text] = first.kept[0] ?? ["", ""];
		const head = text.slice(0, text.indexOf("\n"));
		for (const cut of [
			"",
			"module",
			"modu",
			"commonjs\nx",
			"module\njs(x)",
			head,
			`${head}\n`,
			`${head}\njs(y)@${URL_A}`,
			text.slice(0, -1),
			// As kept before comments were taken out, its hash still sound.
			text.replace(/^module bare /, "module "),
		]) {
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
			"no hooks": { ...STRIPPING, hooks: false },
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
		expect(installKey("/install/one", "v22.23.5", "module")).not.toBe(one);
	});
});

describe("entryWriter", () => {
	it("writes each entry and the install and node it serves, owner-only", async () => {
		const folder = join(root, "cache", "key");
		const made = vi.fn();
		const keep = entryWriter({
			folder,
			held: root,
			served: "/install/one",
			version: "v22.23.5",
			made,
		});
		keep(join(folder, "e1"), "module\none");
		keep(join(folder, "e2"), "module\ntwo");

		await vi.waitFor(async () => {
			expect((await readdir(folder)).sort()).toEqual(["e1", "e2", "root"]);
		});
		expect(await readFile(join(folder, "e2"), "utf8")).toBe("module\ntwo");
		expect(await readFile(join(folder, "root"), "utf8")).toBe(
			"/install/one\nv22.23.5",
		);
		expect((await stat(folder)).mode & 0o777).toBe(0o700);
		expect((await stat(join(folder, "e1"))).mode & 0o777).toBe(0o600);
		expect(made).toHaveBeenCalled();
	});

	it("says once where it can't write, and keeps nothing more", async () => {
		const blocked = join(root, "file");
		await writeFile(blocked, "");
		const folder = join(blocked, "key");
		const said: string[] = [];
		let settle = () => {};
		const reported = new Promise<void>((settled) => {
			settle = settled;
		});
		const keep = entryWriter({
			folder,
			held: root,
			served: "/install/one",
			version: "v22.23.5",
			report: (what) => {
				said.push(what);
				settle();
			},
		});
		keep(join(folder, "e1"), "one");
		keep(join(folder, "e2"), "two");
		await reported;
		expect(said).toEqual([expect.stringContaining("keeps nothing more")]);
		expect(await readdir(root)).toEqual(["file"]);
		// Once stopped, a later entry schedules no write at all.
		vi.useFakeTimers({ toFake: ["setImmediate"] });
		try {
			keep(join(folder, "e3"), "three");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	/** What a writer of `folder` in the root says of its first entry. */
	const refusal = async (folder: string) => {
		const said: string[] = [];
		const made = vi.fn();
		await new Promise<void>((settle) => {
			entryWriter({
				folder,
				held: root,
				served: "/install/one",
				version: "v22.23.5",
				made,
				report: (what) => {
					said.push(what);
					settle();
				},
			})(join(folder, "e1"), "one");
		});
		return { said, made };
	};

	it("writes nothing to a folder others may write", async () => {
		const folder = join(root, "open");
		await mkdir(folder);
		await chmod(folder, 0o777);
		const { said, made } = await refusal(folder);
		expect(said).toEqual([
			expect.stringContaining(`${folder} has mode 777, open to others`),
		]);
		expect(made).not.toBeCalled();
		expect(await readdir(folder)).toEqual([]);
	});

	it("closes a folder above its own that others may write, then writes", async () => {
		const above = join(root, "above");
		const folder = join(above, "key");
		await mkdir(folder, { recursive: true, mode: 0o700 });
		await chmod(above, 0o775);
		const report = vi.fn();
		entryWriter({
			folder,
			held: root,
			served: "/install/one",
			version: "v22.23.5",
			report,
		})(join(folder, "e1"), "one");
		await vi.waitFor(async () => {
			expect((await readdir(folder)).sort()).toEqual(["e1", "root"]);
		});
		expect((await stat(above)).mode & 0o777).toBe(0o755);
		expect(report).not.toBeCalled();
	});

	it("writes nothing through a link above its folder", async () => {
		const real = join(root, "real");
		await mkdir(join(real, "key"), { recursive: true, mode: 0o700 });
		await symlink(real, join(root, "link"));
		const { said, made } = await refusal(join(root, "link", "key"));
		expect(said).toEqual([
			expect.stringContaining(`${join(root, "link")} is a link`),
		]);
		expect(made).not.toBeCalled();
		expect(await readdir(join(real, "key"))).toEqual([]);
	});

	it("writes nothing outside the folder the fence holds", async () => {
		const outside = await realpath(
			await mkdtemp(join(tmpdir(), "stripped-outside-")),
		);
		try {
			const { said, made } = await refusal(join(outside, "key"));
			expect(said).toEqual([
				expect.stringContaining(
					`${join(outside, "key")} doesn't lie within ${root}`,
				),
			]);
			expect(made).not.toBeCalled();
			expect(await readdir(join(outside, "key"))).toEqual([]);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

describe("sweepGone", () => {
	const VERSION = "v22.23.5";
	/** A sweep of `root` by a start serving `served`, keeping "mine". */
	const sweep = (served = join(root, "mine-install"), at = root) =>
		sweepGone({ root: at, keep: "mine", served, version: VERSION });
	/** A folder `name` in the root, naming `served` under `version`. */
	const folder = async (name: string, served?: string, version = VERSION) => {
		await mkdir(join(root, name));
		if (served !== undefined)
			await writeFile(join(root, name, "root"), `${served}\n${version}`);
	};
	/** Seconds since the epoch `days` ago. */
	const daysAgo = (days: number) => (Date.now() - days * 86_400_000) / 1000;

	it("removes the folders of installs gone from the disk, and those naming none an hour on", async () => {
		const live = join(root, "live-install");
		await mkdir(live);
		await folder("mine");
		await folder("live", live);
		await folder("gone", join(root, "no-such-install"));
		await folder("fresh");
		await folder("stale");
		const hourAgo = (Date.now() - 61 * 60 * 1000) / 1000;
		await utimes(join(root, "stale"), hourAgo, hourAgo);

		await sweep();

		expect((await readdir(root)).sort()).toEqual([
			"fresh",
			"live",
			"live-install",
			"mine",
		]);
	});

	/** Mark `name`'s folder and everything in it last used `days` ago. */
	const usedAgo = async (name: string, days: number) => {
		for (const each of await readdir(join(root, name)))
			await utimes(join(root, name, each), daysAgo(days), daysAgo(days));
		await utimes(join(root, name), daysAgo(days), daysAgo(days));
	};

	it("removes its own install's folder under another node once no start has read it for two days", async () => {
		const mine = join(root, "mine-install");
		await mkdir(mine);
		await folder("mine", mine);
		await folder("older node", mine, "v22.22.0");
		await writeFile(join(root, "older node", "entry"), "x");
		await usedAgo("older node", 3.5);
		await mkdir(join(root, "unversioned"));
		await writeFile(join(root, "unversioned", "root"), mine);
		await usedAgo("unversioned", 3.5);

		await sweep(mine);

		expect((await readdir(root)).sort()).toEqual(["mine", "mine-install"]);
	});

	it("keeps its own install's folder under another node while a start still reads it", async () => {
		// As a start from before a switch to another node 22 still does:
		// each start would otherwise sweep the other's away.
		const mine = join(root, "mine-install");
		await mkdir(mine);
		await folder("mine", mine);
		await folder("older node", mine, "v22.22.0");
		for (const name of ["read", "unread"])
			await writeFile(join(root, "older node", name), "x");
		await usedAgo("older node", 4);
		// Marked 2.5 days ago, it may have been read a day after: a read
		// marks an entry only once it is a day old.
		await utimes(join(root, "older node", "read"), daysAgo(2.5), daysAgo(2.5));

		await sweep(mine);

		expect((await readdir(root)).sort()).toEqual([
			"mine",
			"mine-install",
			"older node",
		]);
	});

	it("removes the entries of its own folder no start has read for 30 days", async () => {
		await folder("mine", join(root, "gone"));
		for (const name of ["read", "unread"])
			await writeFile(join(root, "mine", name), "x");
		await utimes(join(root, "mine", "read"), daysAgo(29), daysAgo(29));
		await utimes(join(root, "mine", "unread"), daysAgo(31), daysAgo(31));
		await utimes(join(root, "mine", "root"), daysAgo(90), daysAgo(90));

		await sweep();

		expect(await readdir(root)).toEqual(["mine"]);
		expect((await readdir(join(root, "mine"))).sort()).toEqual([
			"read",
			"root",
		]);
	});

	it("removes a gone folder name by name, taking a link and never what it names, and walks into none", async () => {
		const outside = join(root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "kept"), "x");
		await folder("linked", join(root, "no-such-install"));
		await writeFile(join(root, "linked", "entry"), "x");
		await symlink(outside, join(root, "linked", "out"));
		// The cache writes only files in a folder, so one holding a folder
		// is none it made, and emptying it would take a walk.
		await folder("nested", join(root, "no-such-install"));
		await mkdir(join(root, "nested", "inner"));
		await writeFile(join(root, "nested", "inner", "kept"), "x");

		await sweep();

		expect((await readdir(root)).sort()).toEqual(["nested", "outside"]);
		expect(await readdir(outside)).toEqual(["kept"]);
		expect(await readdir(join(root, "nested", "inner"))).toEqual(["kept"]);
	});

	it("leaves a folder whose install can't be looked at now for a later sweep", async () => {
		const shut = join(root, "shut");
		await mkdir(join(shut, "install"), { recursive: true });
		await folder("unseen", join(shut, "install"));
		await chmod(shut, 0o000);
		try {
			await sweep();
		} finally {
			await chmod(shut, 0o700);
		}
		expect((await readdir(root)).sort()).toEqual(["shut", "unseen"]);
	});

	it("sweeps nothing where nothing was kept", async () => {
		await expect(sweep(undefined, join(root, "none"))).resolves.toBe(undefined);
	});
});

describe("startStrippedSourceCache", () => {
	it("registers its hook where node 22 strips, keeping in the install's folder", () => {
		const register = vi.fn();
		const env = { XDG_STATE_HOME: join(root, ".local", "state") };
		const started = startStrippedSourceCache({
			env,
			home: root,
			packageRoot: "/install/one",
			facts: STRIPPING,
			register,
		});
		expect(started).toEqual({
			state: "on",
			folder: join(
				cacheRoot(env, root),
				installKey("/install/one", "v22.23.5"),
			),
		});
		expect(register).toHaveBeenCalledWith({ load: expect.any(Function) });
	});

	it("stands aside where pi's state lies outside the folder the fence holds", () => {
		const register = vi.fn();
		const started = startStrippedSourceCache({
			env: { XDG_STATE_HOME: join(root, "elsewhere") },
			home: root,
			packageRoot: "/install/one",
			facts: STRIPPING,
			register,
		});
		expect(started).toEqual({
			state: "off",
			reason: expect.stringContaining(heldState(root)),
		});
		expect(register).not.toBeCalled();
	});

	it("fails rather than read through a link in pi's state", async () => {
		const real = join(root, "real");
		await mkdir(join(real, "state", "pi", "agentic-harness.pi"), {
			recursive: true,
		});
		await mkdir(join(root, ".local"));
		await symlink(join(real, "state"), join(root, ".local", "state"));
		const register = vi.fn();
		const started = startStrippedSourceCache({
			env: {},
			home: root,
			packageRoot: "/install/one",
			facts: STRIPPING,
			register,
		});
		expect(started).toEqual({
			state: "failed",
			reason: expect.stringMatching(
				new RegExp(`^${heldState(root)} lies through a link, at `, "u"),
			),
		});
		expect(register).not.toBeCalled();
	});

	it("keeps under a home reached through a link, at the home's real path", async () => {
		const real = join(root, "real-home");
		await mkdir(real);
		const linked = join(root, "home");
		await symlink(real, linked);
		for (const env of [
			{},
			{ XDG_STATE_HOME: join(linked, ".local", "state") },
		]) {
			const register = vi.fn();
			const started = startStrippedSourceCache({
				env,
				home: linked,
				packageRoot: "/install/one",
				facts: STRIPPING,
				register,
			});
			expect(started, JSON.stringify(env)).toEqual({
				state: "on",
				folder: join(
					cacheRoot({}, real),
					installKey("/install/one", "v22.23.5"),
				),
			});
		}
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

	it("fails rather than read a folder others may write", async () => {
		const folder = join(
			cacheRoot({}, root),
			installKey("/install/one", "v22.23.5"),
		);
		await mkdir(folder, { recursive: true, mode: 0o700 });
		await chmod(folder, 0o755);
		const register = vi.fn();
		const started = startStrippedSourceCache({
			env: {},
			home: root,
			packageRoot: "/install/one",
			facts: STRIPPING,
			register,
		});
		expect(started).toEqual({
			state: "failed",
			reason: expect.stringMatching(
				new RegExp(`^${folder} has mode 755, open to others`, "u"),
			),
		});
		expect(register).not.toBeCalled();
	});

	it("closes the folders above its own that others may write, and reads its own", async () => {
		const above = cacheRoot({}, root);
		const folder = join(above, installKey("/install/one", "v22.23.5"));
		await mkdir(folder, { recursive: true, mode: 0o700 });
		await chmod(above, 0o775);
		await chmod(heldState(root), 0o777);
		const register = vi.fn();
		const started = startStrippedSourceCache({
			env: {},
			home: root,
			packageRoot: "/install/one",
			facts: STRIPPING,
			register,
		});
		expect(started).toEqual({ state: "on", folder });
		expect((await stat(above)).mode & 0o777).toBe(0o755);
		expect((await stat(heldState(root))).mode & 0o777).toBe(0o755);
		expect(register).toHaveBeenCalled();
	});

	it("starts where code before it made pi's state under a umask that lets the group write", async () => {
		const was = process.umask(0o002);
		try {
			await mkdir(join(heldState(root), "agentic-harness.pi"), {
				recursive: true,
			});
			expect((await stat(heldState(root))).mode & 0o777).toBe(0o775);
			const started = startStrippedSourceCache({
				env: {},
				home: root,
				packageRoot: "/install/one",
				facts: STRIPPING,
				register: vi.fn(),
			});
			expect(started.state).toBe("on");
		} finally {
			process.umask(was);
		}
	});

	it("leaves a folder of its own that others may write as it is, and fails", async () => {
		const folder = join(
			cacheRoot({}, root),
			installKey("/install/one", "v22.23.5"),
		);
		await mkdir(folder, { recursive: true, mode: 0o700 });
		await chmod(folder, 0o770);
		const started = startStrippedSourceCache({
			env: {},
			home: root,
			packageRoot: "/install/one",
			facts: STRIPPING,
			register: vi.fn(),
		});
		expect(started.state).toBe("failed");
		expect((await stat(folder)).mode & 0o777).toBe(0o770);
	});

	it("names its folder by the package's type as well", async () => {
		const install = join(root, "install");
		await mkdir(install);
		await writeFile(join(install, "package.json"), '{ "type": "module" }');
		const started = startStrippedSourceCache({
			env: {},
			home: root,
			packageRoot: install,
			facts: STRIPPING,
			register: vi.fn(),
		});
		expect(started).toEqual({
			state: "on",
			folder: join(
				cacheRoot({}, root),
				installKey(install, "v22.23.5", "module"),
			),
		});
	});

	it("answers why it failed rather than throwing, leaving node to strip", () => {
		const started = startStrippedSourceCache({
			env: {},
			home: root,
			packageRoot: "/install/one",
			facts: STRIPPING,
			register: () => {
				throw new Error("no hooks here");
			},
		});
		expect(started).toEqual({ state: "failed", reason: "no hooks here" });
	});
});

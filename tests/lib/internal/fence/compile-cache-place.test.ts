/**
 * Where pi points node's compile cache: a private folder of the login's
 * runtime folder, which a fenced command's root empties, or else a
 * folder of pi's state, which the fence holds read-only, whatever the
 * temporary folder was.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	COMPILE_CACHE_VARIABLE,
	compileCacheFolder,
	compileFolderOf,
	keepCompileCacheOutOfReach,
	loginRuntimeFolder,
	RUNTIME_COMPILE,
	runtimeCompileFolders,
} from "../../../../lib/internal/fence/compile-cache-place.ts";
import { fenceRefusesWrite } from "../../../../lib/internal/fence/fence.ts";

/** Only Linux keeps the cache in the runtime folder; elsewhere it's pi's state. */
const onLinux = process.platform === "linux";

const STATE = "/home/someone/.local/state";
const IN_STATE = join(STATE, "pi/agentic-harness.pi");

let dir = "";
let runtime = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "compile-place-"));
	runtime = join(dir, "run");
	mkdirSync(runtime, { mode: 0o700 });
	chmodSync(runtime, 0o700);
	vi.stubEnv("XDG_STATE_HOME", STATE);
	vi.stubEnv("HOME", "/home/someone");
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("where pi's compile cache is kept", () => {
	it.runIf(onLinux)(
		"is a private folder of the runtime folder, not the temporary folder",
		() => {
			vi.stubEnv("XDG_RUNTIME_DIR", runtime);
			vi.stubEnv("TMPDIR", "/tmp/pi-quest-QEST-1");
			const folder = compileFolderOf("node", process.env, "linux", runtime);
			expect(folder).toBe(join(runtime, RUNTIME_COMPILE, "node"));
			expect(statSync(folder).mode & 0o777).toBe(0o700);
			expect(statSync(join(runtime, RUNTIME_COMPILE)).mode & 0o777).toBe(0o700);
		},
	);

	it.runIf(onLinux)(
		"takes the login's runtime folder however it is spelled",
		() => {
			const env = { XDG_RUNTIME_DIR: `${runtime}/` };
			expect(compileFolderOf("node", env, "linux", runtime)).toBe(
				join(runtime, RUNTIME_COMPILE, "node"),
			);
		},
	);

	it.runIf(onLinux)("keeps the host's beside node's, each its own", () => {
		const env = { XDG_RUNTIME_DIR: runtime };
		expect(compileFolderOf("host", env, "linux", runtime)).toBe(
			join(runtime, RUNTIME_COMPILE, "host"),
		);
		expect(runtimeCompileFolders(env, null)).toEqual([
			join(runtime, RUNTIME_COMPILE, "host"),
			join(runtime, RUNTIME_COMPILE, "node"),
		]);
	});

	it("names the login's runtime folder's caches as unwritable, even to a pi started without one", () => {
		expect(
			runtimeCompileFolders({}, "/run/user/1000"),
			"from ssh or cron, with no XDG_RUNTIME_DIR",
		).toEqual([
			"/run/user/1000/pi-compile/host",
			"/run/user/1000/pi-compile/node",
		]);
		expect(
			runtimeCompileFolders({ XDG_RUNTIME_DIR: runtime }, "/run/user/1000"),
			"another runtime folder named, and the login's still",
		).toEqual([
			join(runtime, RUNTIME_COMPILE, "host"),
			join(runtime, RUNTIME_COMPILE, "node"),
			"/run/user/1000/pi-compile/host",
			"/run/user/1000/pi-compile/node",
		]);
		expect(
			runtimeCompileFolders(
				{ XDG_RUNTIME_DIR: "/run/user/1000" },
				"/run/user/1000",
			),
			"each named once",
		).toHaveLength(2);
		expect(loginRuntimeFolder("linux", 1000)).toBe("/run/user/1000");
		expect(loginRuntimeFolder("darwin", 501)).toBeUndefined();
	});

	it("is a folder of pi's state where there is no runtime folder, as on a Mac", () => {
		vi.stubEnv("XDG_RUNTIME_DIR", "");
		vi.stubEnv("TMPDIR", "/tmp/pi-quest-QEST-1");
		expect(compileCacheFolder()).toBe(join(IN_STATE, "node-compile-cache"));
		expect(compileFolderOf("host", {})).toBe(join(IN_STATE, "host-compile"));
		expect(
			runtimeCompileFolders({ XDG_RUNTIME_DIR: "run/user" }, null),
		).toEqual([]);
	});

	it("passes over a runtime folder on any platform but Linux, whose fence alone empties it", () => {
		for (const platform of ["darwin", "freebsd"] as const) {
			expect(
				compileFolderOf(
					"node",
					{ XDG_RUNTIME_DIR: runtime },
					platform,
					runtime,
				),
				platform,
			).toBe(join(IN_STATE, "node-compile-cache"));
		}
		expect(
			compileFolderOf("node", { XDG_RUNTIME_DIR: runtime }, "linux", runtime),
		).toBe(join(runtime, RUNTIME_COMPILE, "node"));
	});

	it.runIf(onLinux)(
		"passes over a runtime folder in the home folder, whose binds the fence lays back over it",
		() => {
			expect(
				compileFolderOf(
					"node",
					{ XDG_RUNTIME_DIR: runtime, HOME: dir },
					"linux",
					runtime,
				),
			).toBe(join(IN_STATE, "node-compile-cache"));
			expect(
				compileFolderOf(
					"host",
					{ XDG_RUNTIME_DIR: runtime, HOME: runtime },
					"linux",
					runtime,
				),
			).toBe(join(IN_STATE, "host-compile"));
			const linkedHome = join(dir, "..", `${basename(dir)}-home`);
			symlinkSync(dir, linkedHome);
			try {
				expect(
					compileFolderOf(
						"node",
						{ XDG_RUNTIME_DIR: runtime, HOME: linkedHome },
						"linux",
						runtime,
					),
					"a home reached through a link",
				).toBe(join(IN_STATE, "node-compile-cache"));
			} finally {
				rmSync(linkedHome);
			}
			expect(
				compileFolderOf(
					"node",
					{ XDG_RUNTIME_DIR: runtime, HOME: `${dir}-beside` },
					"linux",
					runtime,
				),
				"a home beside it, sharing only a prefix",
			).toBe(join(runtime, RUNTIME_COMPILE, "node"));
		},
	);

	/** Where `by`'s cache is kept on Linux, the one platform it may lie in a runtime folder. */
	const onLinuxIn = (by: "host" | "node", root: string) =>
		compileFolderOf(
			by,
			{ XDG_RUNTIME_DIR: root, HOME: "/home/someone" },
			"linux",
			root,
		);

	it("passes over a private runtime folder other than the login's, which another pi's fence leaves open", () => {
		expect(
			compileFolderOf(
				"node",
				{ XDG_RUNTIME_DIR: runtime, HOME: "/home/someone" },
				"linux",
				"/run/user/4242",
			),
		).toBe(join(IN_STATE, "node-compile-cache"));
		expect(
			compileFolderOf(
				"node",
				{ XDG_RUNTIME_DIR: runtime, HOME: "/home/someone" },
				"linux",
				null,
			),
			"with no login runtime folder",
		).toBe(join(IN_STATE, "node-compile-cache"));
	});

	it("passes over a runtime folder others may enter", () => {
		expect(onLinuxIn("node", runtime), "while it is private").toBe(
			join(runtime, RUNTIME_COMPILE, "node"),
		);
		chmodSync(runtime, 0o755);
		expect(onLinuxIn("node", runtime)).toBe(
			join(IN_STATE, "node-compile-cache"),
		);
	});

	it("passes over a runtime folder that is a link, wherever it points", () => {
		const linked = join(dir, "linked-run");
		symlinkSync(runtime, linked);
		expect(onLinuxIn("node", runtime), "the folder itself").toBe(
			join(runtime, RUNTIME_COMPILE, "node"),
		);
		expect(onLinuxIn("node", linked)).toBe(
			join(IN_STATE, "node-compile-cache"),
		);
	});

	it("closes its own empty folder left open, as a fence's mount point is made", () => {
		const shared = join(runtime, RUNTIME_COMPILE);
		mkdirSync(shared, { mode: 0o755 });
		chmodSync(shared, 0o755);

		expect(onLinuxIn("node", runtime)).toBe(join(shared, "node"));

		expect(statSync(shared).mode & 0o777, "closed").toBe(0o700);
	});

	it("passes over its own folder when another made it open with something in it, or put a file there", () => {
		const shared = join(runtime, RUNTIME_COMPILE);
		mkdirSync(shared, { mode: 0o755 });
		mkdirSync(join(shared, "node"), { mode: 0o700 });
		chmodSync(shared, 0o755);
		expect(onLinuxIn("node", runtime)).toBe(
			join(IN_STATE, "node-compile-cache"),
		);
		expect(statSync(shared).mode & 0o777, "left as it was").toBe(0o755);
		chmodSync(shared, 0o700);
		expect(onLinuxIn("node", runtime), "once closed again").toBe(
			join(shared, "node"),
		);
		writeFileSync(join(shared, "host"), "not a folder");
		expect(onLinuxIn("host", runtime)).toBe(join(IN_STATE, "host-compile"));
	});

	it("passes over a folder reached through a link, wherever the link points", () => {
		const elsewhere = join(dir, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		chmodSync(elsewhere, 0o700);
		symlinkSync(elsewhere, join(runtime, RUNTIME_COMPILE));
		expect(onLinuxIn("node", runtime)).toBe(
			join(IN_STATE, "node-compile-cache"),
		);
		mkdirSync(join(elsewhere, "host"), { mode: 0o700 });
		rmSync(join(runtime, RUNTIME_COMPILE));
		mkdirSync(join(runtime, RUNTIME_COMPILE), { mode: 0o700 });
		symlinkSync(
			join(elsewhere, "host"),
			join(runtime, RUNTIME_COMPILE, "host"),
		);
		expect(onLinuxIn("host", runtime)).toBe(join(IN_STATE, "host-compile"));
	});

	it("is where a fenced command can't write, in pi's state or the runtime folder", () => {
		vi.stubEnv("XDG_RUNTIME_DIR", "");
		expect(
			fenceRefusesWrite(join(compileCacheFolder(), "x", "entry"), {
				home: "/home/someone",
				runtimeDir: undefined,
			}),
			"the fence refuses a write into the compile cache in pi's state",
		).toBe(true);
		const roots = [join(runtime, RUNTIME_COMPILE)];
		const cached = join(runtime, RUNTIME_COMPILE, "host", "entry");
		const unfenced = { home: "/home/someone", runtimeDir: undefined };
		expect(
			fenceRefusesWrite(cached, { ...unfenced, compileRoots: roots }),
			"the host's cache in the login's runtime folder, under a pi that fences none",
		).toBe(true);
		expect(
			fenceRefusesWrite(join(runtime, "other", "entry"), {
				...unfenced,
				compileRoots: roots,
			}),
			"the rest of a runtime folder the fence leaves unfenced",
		).toBe(false);
		expect(
			fenceRefusesWrite(cached, { ...unfenced, compileRoots: [] }),
			"with no compile root, as before",
		).toBe(false);
	});

	it.runIf(onLinux)(
		"is named over whatever the environment named before",
		() => {
			vi.stubEnv("XDG_RUNTIME_DIR", runtime);
			const env: Record<string, string> = {
				[COMPILE_CACHE_VARIABLE]: "/tmp/pi-quest-QEST-1/node-compile-cache",
			};
			keepCompileCacheOutOfReach({
				set: (name, value) => {
					env[name] = value;
				},
			});
			expect(env[COMPILE_CACHE_VARIABLE]).toBe(compileCacheFolder());
			expect(env[COMPILE_CACHE_VARIABLE]).not.toContain("/tmp/pi-quest-");
		},
	);
});

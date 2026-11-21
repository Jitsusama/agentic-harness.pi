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
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	COMPILE_CACHE_VARIABLE,
	compileCacheFolder,
	compileFolderOf,
	keepCompileCacheOutOfReach,
	RUNTIME_COMPILE,
	runtimeCompileFolders,
} from "../../../../lib/internal/fence/compile-cache-place.ts";
import { fenceRefusesWrite } from "../../../../lib/internal/fence/fence.ts";

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
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("where pi's compile cache is kept", () => {
	it("is a private folder of the runtime folder, not the temporary folder", () => {
		vi.stubEnv("XDG_RUNTIME_DIR", runtime);
		vi.stubEnv("TMPDIR", "/tmp/pi-quest-QEST-1");
		const folder = compileCacheFolder();
		expect(folder).toBe(join(runtime, RUNTIME_COMPILE, "node"));
		expect(statSync(folder).mode & 0o777).toBe(0o700);
		expect(statSync(join(runtime, RUNTIME_COMPILE)).mode & 0o777).toBe(0o700);
	});

	it("keeps the host's beside node's, each its own", () => {
		const env = { XDG_RUNTIME_DIR: runtime };
		expect(compileFolderOf("host", env)).toBe(
			join(runtime, RUNTIME_COMPILE, "host"),
		);
		expect(runtimeCompileFolders(env)).toEqual([
			join(runtime, RUNTIME_COMPILE, "host"),
			join(runtime, RUNTIME_COMPILE, "node"),
		]);
	});

	it("is a folder of pi's state where there is no runtime folder, as on a Mac", () => {
		vi.stubEnv("XDG_RUNTIME_DIR", "");
		vi.stubEnv("TMPDIR", "/tmp/pi-quest-QEST-1");
		expect(compileCacheFolder()).toBe(join(IN_STATE, "node-compile-cache"));
		expect(compileFolderOf("host", {})).toBe(join(IN_STATE, "host-compile"));
		expect(runtimeCompileFolders({ XDG_RUNTIME_DIR: "run/user" })).toEqual([]);
	});

	it("passes over a runtime folder others may enter", () => {
		chmodSync(runtime, 0o755);
		expect(compileFolderOf("node", { XDG_RUNTIME_DIR: runtime })).toBe(
			join(IN_STATE, "node-compile-cache"),
		);
	});

	it("passes over its own folder when another made it open, or put a file there", () => {
		const shared = join(runtime, RUNTIME_COMPILE);
		mkdirSync(shared, { mode: 0o755 });
		chmodSync(shared, 0o755);
		expect(compileFolderOf("node", { XDG_RUNTIME_DIR: runtime })).toBe(
			join(IN_STATE, "node-compile-cache"),
		);
		chmodSync(shared, 0o700);
		writeFileSync(join(shared, "host"), "not a folder");
		expect(compileFolderOf("host", { XDG_RUNTIME_DIR: runtime })).toBe(
			join(IN_STATE, "host-compile"),
		);
	});

	it("passes over a folder reached through a link, wherever the link points", () => {
		const elsewhere = join(dir, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		chmodSync(elsewhere, 0o700);
		symlinkSync(elsewhere, join(runtime, RUNTIME_COMPILE));
		expect(compileFolderOf("node", { XDG_RUNTIME_DIR: runtime })).toBe(
			join(IN_STATE, "node-compile-cache"),
		);
		mkdirSync(join(elsewhere, "host"), { mode: 0o700 });
		rmSync(join(runtime, RUNTIME_COMPILE));
		mkdirSync(join(runtime, RUNTIME_COMPILE), { mode: 0o700 });
		symlinkSync(
			join(elsewhere, "host"),
			join(runtime, RUNTIME_COMPILE, "host"),
		);
		expect(compileFolderOf("host", { XDG_RUNTIME_DIR: runtime })).toBe(
			join(IN_STATE, "host-compile"),
		);
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
		vi.stubEnv("XDG_RUNTIME_DIR", runtime);
		expect(
			fenceRefusesWrite(join(compileCacheFolder(), "x", "entry"), {
				home: "/home/someone",
				runtimeDir: runtime,
			}),
			"the fence refuses a write into the compile cache in the runtime folder",
		).toBe(true);
	});

	it("is named over whatever the environment named before", () => {
		vi.stubEnv("XDG_RUNTIME_DIR", runtime);
		const env: Record<string, string> = {
			[COMPILE_CACHE_VARIABLE]: "/tmp/pi-quest-QEST-1/node-compile-cache",
		};
		keepCompileCacheOutOfReach({
			set: (name, value) => {
				env[name] = value;
			},
		});
		expect(env[COMPILE_CACHE_VARIABLE]).toBe(
			join(runtime, RUNTIME_COMPILE, "node"),
		);
	});
});

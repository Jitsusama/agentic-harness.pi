/**
 * A host's compile cache: one folder per realm, kind and install, the
 * same one each start of that install, an earlier install's folder of
 * the same host removed and every other host's kept. A cache that can't
 * be had is said, never thrown, since a host starts without one.
 */
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { constants } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCompileCache } from "../../../host/service/compile-cache.ts";

let dir = "";
let root = "";
let pi = "";
let harness = "";
const enabled: string[] = [];

/** Records where the cache was enabled, as node would enable it. */
function enable(directory: string) {
	enabled.push(directory);
	return { status: constants.compileCacheStatus.ENABLED, directory };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "compile-cache-"));
	root = join(dir, "cache");
	pi = join(dir, "pi");
	harness = join(dir, "harness");
	mkdirSync(pi);
	mkdirSync(harness);
	enabled.length = 0;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** The cache a work host of `kind` starts with, over `packageDir`. */
function start(kind: string, packageDir = pi, harnessRoot = harness) {
	return startCompileCache({
		argv: [kind],
		env: { MYCELIUM_REALM: "work", PI_PACKAGE_DIR: packageDir },
		harnessRoot,
		root,
		enable,
	});
}

/** The folder a cache is on in, failing the test when it is not on. */
function folderOf(cache: ReturnType<typeof start>): string {
	if (cache.state !== "on") throw new Error(`cache ${cache.state}`);
	return cache.folder;
}

describe("a host's compile cache", () => {
	// Only Linux's fence empties the runtime folder, so only there does the
	// cache lie in it; elsewhere it would lie in, and sweep, pi's state.
	it.runIf(process.platform === "linux")(
		"lies in the runtime folder by default, which no fenced command sees, not on disk",
		() => {
			// A flush into pi's state held a host's thread 50 s on a contended
			// disk (21 November); a tmpfs waits on none.
			const runtime = join(dir, "run");
			mkdirSync(runtime, { mode: 0o700 });
			vi.stubEnv("XDG_STATE_HOME", join(dir, "state"));
			const inState = join(
				dir,
				"state",
				"pi",
				"agentic-harness.pi",
				"host-compile",
			);
			mkdirSync(join(inState, "work-attended-0123456789abcdef"), {
				recursive: true,
			});
			mkdirSync(join(inState, "work-background-0123456789abcdef"));
			const nodeCache = join(runtime, "pi-compile", "node", "v24-x64-1");
			mkdirSync(nodeCache, { recursive: true, mode: 0o700 });
			chmodSync(join(runtime, "pi-compile"), 0o700);
			chmodSync(join(runtime, "pi-compile", "node"), 0o700);
			const idle = join(nodeCache, "unused");
			writeFileSync(idle, "compiled");
			const long = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
			utimesSync(idle, long, long);
			const used = join(nodeCache, "used");
			writeFileSync(used, "compiled");
			try {
				const folder = folderOf(
					startCompileCache({
						argv: ["attended"],
						env: {
							MYCELIUM_REALM: "work",
							PI_PACKAGE_DIR: pi,
							XDG_RUNTIME_DIR: runtime,
							HOME: join(dir, "home"),
						},
						harnessRoot: harness,
						login: runtime,
						enable,
					}),
				);
				expect(
					folder.startsWith(`${join(runtime, "pi-compile", "host")}/`),
					`the cache folder ${folder} sits in the runtime folder's pi-compile/host`,
				).toBe(true);
				expect(
					readdirSync(inState),
					"its own folders left in pi's state are swept, and no other host's",
				).toEqual(["work-background-0123456789abcdef"]);
				expect(
					readdirSync(nodeCache),
					"what node's cache holds that nothing used for a day is swept, as memory",
				).toEqual(["used"]);
			} finally {
				vi.unstubAllEnvs();
			}
		},
	);

	it.runIf(process.platform === "linux")(
		"stays on in the runtime folder when what it left in pi's state can't be swept",
		() => {
			const runtime = join(dir, "run");
			mkdirSync(runtime, { mode: 0o700 });
			vi.stubEnv("XDG_STATE_HOME", join(dir, "state"));
			const state = join(dir, "state", "pi", "agentic-harness.pi");
			mkdirSync(state, { recursive: true });
			// A file where its folder was, which no sweep can read.
			writeFileSync(join(state, "host-compile"), "");
			try {
				const cache = startCompileCache({
					argv: ["attended"],
					env: {
						MYCELIUM_REALM: "work",
						PI_PACKAGE_DIR: pi,
						XDG_RUNTIME_DIR: runtime,
						HOME: join(dir, "home"),
					},
					harnessRoot: harness,
					login: runtime,
					enable,
				});
				expect(cache.state, JSON.stringify(cache)).toBe("on");
			} finally {
				vi.unstubAllEnvs();
			}
		},
	);

	it("lies in pi's state without a runtime folder, which the fence holds read-only, not its cache", () => {
		// node runs what it reads back from here at the next start, outside
		// the fence, and ~/.cache is writable inside (04TNWT, 19 November).
		const state = join(dir, "state");
		vi.stubEnv("XDG_STATE_HOME", state);
		vi.stubEnv("XDG_CACHE_HOME", join(dir, "xdg-cache"));
		try {
			const folder = folderOf(
				startCompileCache({
					argv: ["attended"],
					env: { MYCELIUM_REALM: "work", PI_PACKAGE_DIR: pi },
					harnessRoot: harness,
					enable,
				}),
			);
			expect(
				folder.startsWith(`${join(state, "pi", "agentic-harness.pi")}/`),
				`the cache folder ${folder} sits in pi's state`,
			).toBe(true);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("keeps what it compiled in pi's state for the next start there, sweeping only earlier installs", () => {
		vi.stubEnv("XDG_STATE_HOME", join(dir, "state"));
		const inState = () =>
			folderOf(
				startCompileCache({
					argv: ["attended"],
					env: { MYCELIUM_REALM: "work", PI_PACKAGE_DIR: pi },
					harnessRoot: harness,
					login: null,
					enable,
				}),
			);
		try {
			const folder = inState();
			writeFileSync(join(folder, "compiled"), "code");

			expect(inState(), "the same folder").toBe(folder);

			expect(readdirSync(folder), "what it compiled kept").toEqual([
				"compiled",
			]);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("keeps one folder for its install, removing its own earlier ones and no other host's", () => {
		mkdirSync(join(root, "work-attended-0123456789abcdef"), {
			recursive: true,
		});
		mkdirSync(join(root, "work-background-0123456789abcdef"));
		mkdirSync(join(root, "home-attended-0123456789abcdef"));

		const folder = folderOf(start("attended"));

		expect(enabled, "node was given the folder").toEqual([folder]);
		expect(basename(folder)).toMatch(/^work-attended-[0-9a-f]{16}$/);
		expect(readdirSync(root).sort()).toEqual(
			[
				basename(folder),
				"home-attended-0123456789abcdef",
				"work-background-0123456789abcdef",
			].sort(),
		);
	});

	it("names the same folder for the same install, however it is reached, and another for another pi", () => {
		const linked = join(dir, "current");
		symlinkSync(harness, linked);
		const other = join(dir, "other-pi");
		mkdirSync(other);

		const first = folderOf(start("background"));
		const again = folderOf(start("background", pi, linked));
		const elsewhere = folderOf(start("background", other));

		expect(again, "a link to the harness is the same install").toBe(first);
		expect(elsewhere, "another pi is another install").not.toBe(first);
		expect(
			readdirSync(root),
			"only the latest install's folder is left",
		).toEqual([basename(elsewhere)]);
	});

	it("says why it is off, without throwing, when its folder can't be made or node refuses it", () => {
		writeFileSync(root, "not a folder");
		const blocked = start("attended");
		expect(blocked.state).toBe("off");
		expect(enabled, "node was never asked").toEqual([]);

		rmSync(root);
		const refused = startCompileCache({
			argv: ["attended"],
			env: { MYCELIUM_REALM: "work", PI_PACKAGE_DIR: pi },
			harnessRoot: harness,
			root,
			enable: () => ({
				status: constants.compileCacheStatus.FAILED,
				message: "no room",
			}),
		});
		expect(refused).toEqual({ state: "off", reason: "no room" });
	});

	it("makes nothing for a host the program will refuse", () => {
		expect(start("sideways").state).toBe("unkeyed");
		expect(start("attended", join(dir, "no-pi")).state).toBe("unkeyed");
		expect(start("attended", "relative/pi").state).toBe("unkeyed");
		expect(
			startCompileCache({
				argv: ["attended"],
				env: { PI_PACKAGE_DIR: pi },
				harnessRoot: harness,
				root,
				enable,
			}).state,
		).toBe("unkeyed");
		expect(enabled, "node was never asked").toEqual([]);
		expect(readdirSync(dir).sort()).toEqual(["harness", "pi"]);
	});
});

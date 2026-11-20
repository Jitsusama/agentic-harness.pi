/**
 * Where pi points node's compile cache: a folder of pi's state, which
 * the fence holds read-only, whatever the temporary folder was.
 */

import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	COMPILE_CACHE_VARIABLE,
	compileCacheFolder,
	keepCompileCacheOutOfReach,
} from "../../../../lib/internal/fence/compile-cache-place.ts";
import { fenceRefusesWrite } from "../../../../lib/internal/fence/fence.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("where pi's compile cache is kept", () => {
	it("is a folder of pi's state, not the temporary folder", () => {
		vi.stubEnv("XDG_STATE_HOME", "/home/someone/.local/state");
		vi.stubEnv("TMPDIR", "/tmp/pi-quest-QEST-1");
		expect(compileCacheFolder()).toBe(
			join(
				"/home/someone/.local/state/pi/agentic-harness.pi",
				"node-compile-cache",
			),
		);
	});

	it("is where a fenced command can't write", () => {
		vi.stubEnv("XDG_STATE_HOME", "/home/someone/.local/state");
		expect(
			fenceRefusesWrite(join(compileCacheFolder(), "x", "entry"), {
				home: "/home/someone",
				runtimeDir: undefined,
			}),
			"the fence refuses a write into the compile cache",
		).toBe(true);
	});

	it("is named over whatever the environment named before", () => {
		vi.stubEnv("XDG_STATE_HOME", "/home/someone/.local/state");
		const env: Record<string, string> = {
			[COMPILE_CACHE_VARIABLE]: "/tmp/pi-quest-QEST-1/node-compile-cache",
		};
		keepCompileCacheOutOfReach({
			set: (name, value) => {
				env[name] = value;
			},
		});
		expect(env[COMPILE_CACHE_VARIABLE]).toBe(compileCacheFolder());
	});
});

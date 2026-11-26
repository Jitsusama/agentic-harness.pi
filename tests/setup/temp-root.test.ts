/**
 * Where a test run's temp directory goes: under the host's own temporary
 * folder, except on a Mac whose folder is its own default, which sits so
 * deep under /var/folders that the sockets the host's tests make there
 * run past the 104 bytes a Unix socket's path may take.
 */

import type * as Fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import setup, { runRootBase, SOCKET_ROOT } from "./temp-root.ts";

// Named rather than made or removed, so the setup's own run is read
// without writing where this machine's /tmp may not let a test write.
vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof Fs>()),
	mkdtempSync: vi.fn((prefix: string) => `${prefix}XXXXXX`),
	rmSync: vi.fn(),
}));

/** A Mac's own TMPDIR, as `os.tmpdir()` gives it. */
const MAC_TMPDIR = "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T";

describe("a test run's temp root", () => {
	it("goes under /tmp on a Mac, whose own TMPDIR is too deep for a socket", () => {
		expect(runRootBase("darwin", MAC_TMPDIR)).toBe("/tmp");
		expect(runRootBase("darwin", `/private${MAC_TMPDIR}`), "as resolved").toBe(
			"/tmp",
		);
	});

	// A session's own scratch may be the one place a fenced run can write.
	it("stays under a TMPDIR a session set on a Mac", () => {
		expect(runRootBase("darwin", "/tmp/pi-quest-x")).toBe("/tmp/pi-quest-x");
	});

	it("stays under the host's own temporary folder on Linux", () => {
		expect(runRootBase("linux", "/tmp/pi-quest-x")).toBe("/tmp/pi-quest-x");
	});

	it("is where the run's setup makes its directory", () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "darwin" });
		vi.stubEnv("TMPDIR", MAC_TMPDIR);
		// So this worker's own short folder comes back once the case ends.
		vi.stubEnv(SOCKET_ROOT, process.env[SOCKET_ROOT]);
		try {
			const teardown = setup();
			expect(vi.mocked(mkdtempSync)).toHaveBeenCalledWith("/tmp/vitest-run-");
			expect(process.env.TMPDIR, "the run's TMPDIR").toBe(
				"/tmp/vitest-run-XXXXXX",
			);
			teardown();
			expect(process.env.TMPDIR, "given back at its end").toBe(MAC_TMPDIR);
		} finally {
			if (platform !== undefined)
				Object.defineProperty(process, "platform", platform);
			vi.unstubAllEnvs();
		}
	});

	// A session's TMPDIR, made 18 bytes longer by the run's own folder,
	// leaves a socket test nowhere short to listen.
	it("names a short folder for sockets under /tmp, and removes it at its end", () => {
		vi.stubEnv("TMPDIR", "/tmp/pi-quest-x");
		vi.stubEnv(SOCKET_ROOT, process.env[SOCKET_ROOT]);
		vi.mocked(rmSync).mockClear();
		try {
			const teardown = setup();
			expect(process.env[SOCKET_ROOT], "while the run lasts").toBe(
				"/tmp/vs-XXXXXX",
			);
			teardown();
			expect(process.env[SOCKET_ROOT], "after it").toBeUndefined();
			expect(vi.mocked(rmSync)).toHaveBeenCalledWith("/tmp/vs-XXXXXX", {
				recursive: true,
				force: true,
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});

	// As under a fence that grants a fenced run only its TMPDIR.
	it("names none where /tmp can't be written, and still runs", () => {
		vi.stubEnv("TMPDIR", "/tmp/pi-quest-x");
		// Unset, rather than this worker's own, so only setup could name one.
		vi.stubEnv(SOCKET_ROOT, undefined);
		vi.mocked(mkdtempSync).mockImplementation((prefix) => {
			if (String(prefix).startsWith("/tmp/vs-"))
				throw new Error("EACCES: permission denied");
			return `${prefix}XXXXXX`;
		});
		try {
			const teardown = setup();
			expect(process.env[SOCKET_ROOT], "no short folder").toBeUndefined();
			expect(process.env.TMPDIR, "the run's TMPDIR").toBe(
				"/tmp/pi-quest-x/vitest-run-XXXXXX",
			);
			teardown();
		} finally {
			vi.mocked(mkdtempSync).mockImplementation((prefix) => `${prefix}XXXXXX`);
			vi.unstubAllEnvs();
		}
	});
});

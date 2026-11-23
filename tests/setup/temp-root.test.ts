/**
 * Where a test run's temp directory goes: under the host's own temporary
 * folder, except on a Mac whose folder is its own default, which sits so
 * deep under /var/folders that the sockets the host's tests make there
 * run past the 104 bytes a Unix socket's path may take.
 */

import type * as Fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import setup, { runRootBase } from "./temp-root.ts";

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
});

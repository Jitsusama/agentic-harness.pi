/**
 * Where a test run's temp directory goes: under the host's own temporary
 * folder, except on a Mac whose folder is its own default, which sits so
 * deep under /var/folders that the sockets the host's tests make there
 * run past the 104 bytes a Unix socket's path may take.
 */

import { describe, expect, it } from "vitest";
import { runRootBase } from "./temp-root.ts";

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
});

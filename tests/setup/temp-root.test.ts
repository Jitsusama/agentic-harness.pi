/**
 * Where a test run's temp directory goes: under the host's own temporary
 * folder, except on a Mac, whose folder sits so deep under /var/folders
 * that the sockets the host's tests make there run past the 104 bytes a
 * Unix socket's path may take.
 */

import { describe, expect, it } from "vitest";
import { runRootBase } from "./temp-root.ts";

/** A Mac's own TMPDIR, as `os.tmpdir()` gives it. */
const MAC_TMPDIR = "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T";

describe("a test run's temp root", () => {
	it("goes under /tmp on a Mac, whose own TMPDIR is too deep for a socket", () => {
		expect(runRootBase("darwin", MAC_TMPDIR)).toBe("/tmp");
	});

	it("stays under the host's own temporary folder on Linux", () => {
		expect(runRootBase("linux", "/tmp/pi-quest-x")).toBe("/tmp/pi-quest-x");
	});
});

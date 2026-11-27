import { describe, expect, it } from "vitest";
import {
	alive,
	childOf,
	noSuchProcess,
	residentMb,
	runningIn,
	runningWith,
} from "./processes.ts";

/** A BSD ps -wwE -A -o pid=,command= listing, as a Mac prints one. */
const LISTING = [
	"    1 /sbin/launchd",
	"  412 /usr/bin/node /x/host.js HOME=/Users/joel PATH=/usr/bin",
	"  413 /usr/bin/node /x/other.js HOME=/tmp/case-7 PATH=/usr/bin",
	"  414 /usr/bin/node /x/host.js HOME=/tmp/case-7 PATH=/usr/bin",
	"",
].join("\n");

describe("runningIn", () => {
	it("finds the process whose words and environment both match", () => {
		expect(
			runningIn(LISTING, ["/usr/bin/node", "/x/host.js"], "HOME=/tmp/case-7"),
			"the case's own host is 414, not 412 (another HOME) or 413 (another program)",
		).toBe(414);
	});

	it("finds a command carrying more words than asked, by its entry", () => {
		expect(
			runningIn(
				"  30 /usr/bin/node /x/host.js --flag HOME=/tmp/case-9\n",
				["/usr/bin/node", "/x/host.js"],
				"HOME=/tmp/case-9",
			),
			"the listing can't tell --flag from an environment entry",
		).toBe(30);
	});

	it("finds nothing when no environment holds the entry", () => {
		expect(
			runningIn(LISTING, ["/usr/bin/node", "/x/host.js"], "HOME=/tmp/case-8"),
			"no process runs with HOME=/tmp/case-8",
		).toBeUndefined();
	});

	it("skips lines that start with no pid", () => {
		expect(
			runningIn("PID COMMAND\n  9 /bin/sh HOME=/h\n", ["/bin/sh"], "HOME=/h"),
			"the header is passed over and 9 found",
		).toBe(9);
	});
});

describe("this machine's processes", () => {
	it("reads this process as alive and a probed free pid as not", () => {
		expect(alive(process.pid), "this test's own pid").toBe(true);
		expect(alive(noSuchProcess()), "a pid nothing wears").toBe(false);
	});

	it("reads this process's memory as some MB", () => {
		const mb = residentMb(process.pid);
		expect(
			mb,
			`a node process holds more than 1 MB, read ${mb}`,
		).toBeGreaterThan(1);
	});

	it("refuses to read the memory of a process that never started", () => {
		expect(() => residentMb(undefined)).toThrow("no pid to read memory of");
	});

	it("finds no child of a process that started none", () => {
		expect(
			childOf(noSuchProcess()),
			"a free pid has no children",
		).toBeUndefined();
	});

	it("finds no process running a command nobody runs", () => {
		expect(
			runningWith(["/no/such/program"], `HOME=/nowhere/${process.pid}`),
			"nothing runs /no/such/program",
		).toBeUndefined();
	});
});

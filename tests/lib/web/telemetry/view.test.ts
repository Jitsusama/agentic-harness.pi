/**
 * Reading a captured run back. The counts have to be of
 * everything captured, not of the window on screen, or a
 * summary that says "no errors" would be a lie told by paging.
 */

import { describe, expect, it } from "vitest";
import type { LogEntry } from "../../../../lib/web/telemetry/console.js";
import { renderLogs } from "../../../../lib/web/telemetry/view.js";

const at = (seq: number, entry: Partial<LogEntry> = {}) => ({
	seq,
	item: {
		source: "console",
		level: "log",
		text: "something",
		timestamp: 1000 + seq,
		...entry,
	},
});

describe("renderLogs", () => {
	it("says nothing happened rather than printing an empty list", () => {
		expect(renderLogs({ entries: [], dropped: 0, cursor: 0 })).toBe(
			"The page has not logged anything.",
		);
	});

	it("leads with a tally, worst level first", () => {
		const out = renderLogs({
			entries: [
				at(1, { level: "log", text: "one" }),
				at(2, { level: "error", text: "two" }),
				at(3, { level: "warning", text: "three" }),
				at(4, { level: "log", text: "four" }),
			],
			dropped: 0,
			cursor: 4,
		});
		expect(out.split("\n")[0]).toBe("1 error, 1 warning, 2 logs.");
	});

	it("counts one of something in the singular", () => {
		const out = renderLogs({
			entries: [at(1, { level: "error", text: "boom" })],
			dropped: 0,
			cursor: 1,
		});
		expect(out.split("\n")[0]).toBe("1 error.");
	});

	it("shows the level and the text of each entry", () => {
		const out = renderLogs({
			entries: [at(7, { level: "warning", text: "careful" })],
			dropped: 0,
			cursor: 7,
		});
		expect(out).toContain("warning  careful");
	});

	it("puts the origin where it can be followed", () => {
		const out = renderLogs({
			entries: [
				at(1, {
					level: "error",
					text: "boom",
					origin: "file:///noisy.html:19:11",
				}),
			],
			dropped: 0,
			cursor: 1,
		});
		expect(out).toContain("file:///noisy.html:19:11");
	});

	it("admits what the buffer evicted instead of quietly dropping it", () => {
		const out = renderLogs({
			entries: [at(2001)],
			dropped: 12,
			cursor: 2001,
		});
		expect(out).toContain("12 earlier entries were dropped");
	});

	it("gives the cursor to resume from, so a follow-up reads only what is new", () => {
		const out = renderLogs({ entries: [at(41)], dropped: 0, cursor: 41 });
		expect(out).toContain("since: 41");
	});

	it("names the source when it is not the page's own console", () => {
		const out = renderLogs({
			entries: [
				at(1, {
					source: "network",
					level: "error",
					text: "Failed to load resource: net::ERR_FILE_NOT_FOUND",
				}),
			],
			dropped: 0,
			cursor: 1,
		});
		expect(out).toContain("network");
	});

	it("states a shared path once rather than on every line", () => {
		const out = renderLogs({
			entries: [
				at(1, { origin: "file:///long/path/to/noisy.html:5:9" }),
				at(2, { origin: "file:///long/path/to/noisy.html:6:9" }),
				at(3, { origin: "file:///long/path/to/other.js:1:1" }),
			],
			dropped: 0,
			cursor: 3,
		});
		expect(out).toContain("file:///long/path/to/");
		expect(out).toContain("noisy.html:5:9");
		expect(out).not.toContain("file:///long/path/to/noisy.html:5:9");
	});

	it("leaves a lone origin alone, since there is no repetition to spare", () => {
		const out = renderLogs({
			entries: [at(1, { origin: "file:///only/one.html:5:9" })],
			dropped: 0,
			cursor: 1,
		});
		expect(out).toContain("file:///only/one.html:5:9");
	});

	it("hoists the common directory even when one origin sits elsewhere", () => {
		const out = renderLogs({
			entries: [
				at(1, { origin: "file:///long/path/to/noisy.html:5:9" }),
				at(2, { origin: "file:///long/path/to/noisy.html:6:9" }),
				at(3, { origin: "file:///elsewhere.png" }),
			],
			dropped: 0,
			cursor: 3,
		});
		expect(out).toContain("Paths below are under file:///long/path/to/");
		expect(out).not.toContain("file:///long/path/to/noisy.html:5:9");
		// The outlier keeps its own path, since the hoist does not
		// cover it and a bare name would point nowhere.
		expect(out).toContain("file:///elsewhere.png");
	});

	it("keeps origins whole when they share no path", () => {
		const out = renderLogs({
			entries: [
				at(1, { origin: "https://a.example/x.js:1:1" }),
				at(2, { origin: "https://b.example/y.js:2:2" }),
			],
			dropped: 0,
			cursor: 2,
		});
		expect(out).toContain("https://a.example/x.js:1:1");
		expect(out).toContain("https://b.example/y.js:2:2");
	});

	it("drops a stack that only repeats the origin it sits under", () => {
		const out = renderLogs({
			entries: [
				at(1, {
					level: "error",
					text: "boom",
					origin: "file:///a.js:2:3",
					stack: "    at file:///a.js:2:3",
				}),
			],
			dropped: 0,
			cursor: 1,
		});
		expect(out.split("file:///a.js:2:3").length - 1).toBe(1);
	});

	it("includes a stack when one was captured", () => {
		const out = renderLogs({
			entries: [
				at(1, {
					level: "error",
					text: "boom",
					origin: "file:///a.js:2:3",
					stack: "    at f file:///a.js:2:3\n    at g file:///b.js:9:1",
				}),
			],
			dropped: 0,
			cursor: 1,
		});
		expect(out).toContain("at f file:///a.js:2:3");
	});
});

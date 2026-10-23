/**
 * A stray write is read for a person: its first line, and whose it was,
 * from the frames that name somebody other than pi or node.
 */

import { describe, expect, it } from "vitest";
import { reportOf } from "../../../../lib/internal/stray/report.ts";

const PI =
	"/nix/store/abc-pi-coding-agent-1.4.0/lib/node_modules/pi-monorepo/dist/core/event-bus.js";
const HARNESS =
	"/home/joel/.pi/agent/git/github.com/Jitsusama/agentic-harness.pi";

describe("reading a stray write", () => {
	it("names the handler's extension and channel when pi's bus wrote it", () => {
		const text = [
			"Event handler error (jobs:finished:v1): TypeError: lease is not a function",
			`    at Object.ended (${HARNESS}/extensions/mesh-workflow/leases.ts:88:5)`,
			`    at safeHandler (file://${PI}:11:27)`,
		].join("\n");

		const report = reportOf({
			kind: "console.error",
			text,
			stack: `    at Object.on (file://${PI}:14:29)`,
		});

		expect(report).toEqual({
			line: "TypeError: lease is not a function",
			writer: "mesh-workflow",
			channel: "jobs:finished:v1",
		});
	});

	it("names a package from the call stack when the text carries no frames", () => {
		const core = `${HARNESS}/node_modules/.pnpm/@jitsusama+agentic-harness.core@0.15.2/node_modules/@jitsusama/agentic-harness.core/dist/quest/lifecycle.js`;

		const report = reportOf({
			kind: "console.warn",
			text: "[quest] failed to append Journey entry to /q; README missing or unreadable.",
			stack: `    at appendJourneyEntry (${core}:304:17)\n    at Object.run (${HARNESS}/extensions/quest-workflow/index.ts:90:3)`,
		});

		expect(report.writer).toBe("@jitsusama/agentic-harness.core");
		expect(report.channel).toBeUndefined();
	});

	it("strips colour and cuts a long line to fit a notice", () => {
		const report = reportOf({
			kind: "stderr",
			text: `\n\u001b[33m${"x".repeat(400)}\u001b[39m\nsecond line`,
			stack: "",
		});

		expect(report.line).toHaveLength(160);
		expect(report.line.endsWith("...")).toBe(true);
		expect(report.line).not.toContain("\u001b");
		expect(report.writer).toBeUndefined();
	});
});

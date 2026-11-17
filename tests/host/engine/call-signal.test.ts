/**
 * A tool call on the host's agent starts its commands under no earlier
 * call's signal. Review tools run each call inside `withCallSignal`, and
 * durable aborts a call's signal once the call ends. Work the call leaves
 * behind keeps its context, so whatever that work starts on the host,
 * and whatever durable's drain starts once it is kicked from there,
 * would run later calls' commands under the dead signal: they stopped
 * before they started ("git aborted before it started").
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { hostPiFor } from "../end-to-end/support/host-pi.ts";

const run = promisify(execFile);
/** The host's pi, found again for each case, which skips or fails without one. */
let packageDir = "";
beforeEach(({ skip }) => {
	packageDir = hostPiFor(skip);
});
const FIXTURE = join(import.meta.dirname, "fixtures", "hosted-session.mts");
/** Two sessions in two processes, each loading pi's whole package. */
const SESSION_PAIR_MS = 60_000;

/** The call signal a later call's commands would stop with, on pi's agent or the host's. */
async function laterCallSignal(mode: "pi" | "hosted"): Promise<unknown[]> {
	const { stdout } = await run(
		process.execPath,
		["--no-warnings", FIXTURE, packageDir, mode, "call-signal"],
		{
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				TMPDIR: process.env.TMPDIR ?? "",
			},
		},
	);
	const observed: { events: { type: string }[] } = JSON.parse(stdout);
	return observed.events.filter((event) => event.type === "call signal");
}

describe("a tool call's commands on the host's agent", {
	timeout: SESSION_PAIR_MS,
}, () => {
	it("start under no signal an earlier call left behind, though pi's agent carries it on", async () => {
		const [ours, hosted] = await Promise.all([
			laterCallSignal("pi"),
			laterCallSignal("hosted"),
		]);
		// pi's agent runs the later call in the left work's context, under a signal pi never aborts.
		expect(ours).toEqual([{ type: "call signal", signal: "live" }]);
		expect(hosted).toEqual([{ type: "call signal", signal: "none" }]);
	});
});

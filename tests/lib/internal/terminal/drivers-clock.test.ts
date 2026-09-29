import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmuxDriver } from "../../../../lib/internal/terminal/drivers/tmux.ts";
import { createWeztermDriver } from "../../../../lib/internal/terminal/drivers/wezterm.ts";

/** Longer than a call given up on should take to end. */
const STILL_RUNNING_MS = 5000;
/** The clock these drivers are built with, short enough to wait out. */
const CLI_MS = 300;

/** The call's outcome, or a note that it was still waiting. */
async function outcome(call: Promise<unknown>): Promise<unknown> {
	const running = new Promise<string>((resolve) =>
		setTimeout(() => resolve("still running"), STILL_RUNNING_MS),
	);
	return Promise.race([
		call.then(
			(value) => ({ answered: value }),
			() => "failed",
		),
		running,
	]);
}

// A terminal's cli talks to a mux over a socket, and a mux that is
// wedged, or a socket left behind by one that died, accepts and never
// answers. Quest's spawn verbs wait on these calls, and quest takes its
// calls one at a time, so one hung cli held every later quest call.
describe("a terminal cli that never answers", () => {
	let bin: string;
	const saved: Record<string, string | undefined> = {};

	const fake = (name: string, script: string): void => {
		const file = join(bin, name);
		writeFileSync(file, `#!/bin/sh\n${script}\n`);
		chmodSync(file, 0o755);
	};

	beforeEach(() => {
		bin = mkdtempSync(join(tmpdir(), "fake-term-"));
		for (const key of ["PATH", "WEZTERM_UNIX_SOCKET"])
			saved[key] = process.env[key];
		process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ""}`;
		process.env.WEZTERM_UNIX_SOCKET = "/nowhere/sock";
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(bin, { recursive: true, force: true });
	});

	it("gives up on a wezterm spawn at its clock", async () => {
		fake("wezterm", "sleep 30");
		const driver = createWeztermDriver({ cliTimeoutMs: CLI_MS });
		expect(await outcome(driver.spawn({ layout: "tab" }))).toBe("failed");
	}, 15_000);

	it("gives up on typing into a wezterm pane at its clock", async () => {
		fake("wezterm", "sleep 30");
		const driver = createWeztermDriver({ cliTimeoutMs: CLI_MS });
		const pane = {
			driverId: "wezterm",
			kind: "wezterm-pane",
			hostId: hostname(),
			value: "7",
		};
		expect(await outcome(driver.typeInto(pane, "echo hi\n"))).toBe("failed");
	}, 15_000);

	it("reports a wezterm pane unknown when the mux will not list them", async () => {
		fake("wezterm", "sleep 30");
		const driver = createWeztermDriver({ cliTimeoutMs: CLI_MS });
		const pane = {
			driverId: "wezterm",
			kind: "wezterm-pane",
			hostId: hostname(),
			scope: "/nowhere/sock",
			value: "7",
		};
		const answer = await outcome(driver.probe([pane]));
		expect(answer).not.toBe("still running");
	}, 15_000);

	it("gives up on a tmux spawn at its clock", async () => {
		fake("tmux", "sleep 30");
		const driver = createTmuxDriver({ cliTimeoutMs: CLI_MS });
		expect(await outcome(driver.spawn({ layout: "tab" }))).toBe("failed");
	}, 15_000);

	it("still names the pane a wezterm that answers made", async () => {
		fake("wezterm", "echo 42");
		const driver = createWeztermDriver({ cliTimeoutMs: 5000 });
		expect(await outcome(driver.spawn({ layout: "tab" }))).toMatchObject({
			answered: { driverId: "wezterm", value: "42" },
		});
	}, 15_000);

	it("still spawns through a tmux that answers", async () => {
		fake("tmux", "exit 0");
		const driver = createTmuxDriver({ cliTimeoutMs: 5000 });
		expect(await outcome(driver.spawn({ layout: "tab" }))).toEqual({
			answered: undefined,
		});
	}, 15_000);
});

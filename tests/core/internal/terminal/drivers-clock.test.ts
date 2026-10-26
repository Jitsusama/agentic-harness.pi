import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetBinaries } from "../../../../lib/core/internal/terminal/binaries.ts";
import { createKittyDriver } from "../../../../lib/core/internal/terminal/drivers/kitty.ts";
import { createTmuxDriver } from "../../../../lib/core/internal/terminal/drivers/tmux.ts";
import { createWeztermDriver } from "../../../../lib/core/internal/terminal/drivers/wezterm.ts";
import { createZellijDriver } from "../../../../lib/core/internal/terminal/drivers/zellij.ts";
import type { TerminalSessionHandle } from "../../../../lib/terminal/index.ts";

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

const handle = (
	driverId: string,
	value: string,
	scope: string,
): TerminalSessionHandle => ({
	driverId,
	kind: `${driverId}-pane`,
	hostId: hostname(),
	scope,
	value,
});

// A terminal's cli talks to a running terminal over a socket, and one
// that is wedged, or a socket left behind by one that died, accepts and
// never answers. Every call has to end at its clock regardless.
describe("a terminal cli that never answers, or answers", () => {
	let bin: string;
	let savedPath: string | undefined;

	const fake = (name: string, script: string): void => {
		const file = join(bin, name);
		writeFileSync(file, `#!/bin/sh\n${script}\n`);
		chmodSync(file, 0o755);
	};

	beforeEach(() => {
		bin = mkdtempSync(join(tmpdir(), "fake-term-"));
		savedPath = process.env.PATH;
		process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
		forgetBinaries();
	});

	afterEach(() => {
		process.env.PATH = savedPath;
		forgetBinaries();
		rmSync(bin, { recursive: true, force: true });
	});

	const env = {
		KITTY_LISTEN_ON: "unix:@nowhere",
		WEZTERM_UNIX_SOCKET: "/nowhere/sock",
		TMUX: "/nowhere/tmux,1,0",
		ZELLIJ_SESSION_NAME: "nowhere",
	};
	// Typing waits for a prompt first; these fakes never draw one, so the
	// wait is held to the cli clock and the call still ends in time.
	const clocks = (ms: number) => ({
		cliTimeoutMs: ms,
		promptWaitMs: ms,
		env: () => env,
	});
	const drivers = {
		kitty: (ms: number) => createKittyDriver(clocks(ms)),
		wezterm: (ms: number) => createWeztermDriver(clocks(ms)),
		tmux: (ms: number) => createTmuxDriver(clocks(ms)),
		zellij: (ms: number) => createZellijDriver(clocks(ms)),
	};

	for (const [id, make] of Object.entries(drivers)) {
		it(`gives up on a ${id} spawn at its clock`, async () => {
			fake(id, "sleep 30");
			expect(await outcome(make(CLI_MS).spawn({ layout: "tab" }))).toBe(
				"failed",
			);
		}, 15_000);

		it(`gives up on typing into ${id} at its clock`, async () => {
			fake(id, "sleep 30");
			const target = handle(id, "7", "/nowhere/sock");
			expect(await outcome(make(CLI_MS).typeInto(target, "echo hi\n"))).toBe(
				"failed",
			);
		}, 15_000);

		it(`reports a ${id} surface unknown when the terminal will not list them`, async () => {
			fake(id, "sleep 30");
			const target = handle(id, "7", "/nowhere/sock");
			const answer = (await outcome(make(CLI_MS).probe([target]))) as {
				answered?: Map<string, string>;
			};
			expect([...(answer.answered?.values() ?? [])]).toEqual(["unknown"]);
		}, 15_000);
	}

	it("names the window a kitty that answers made", async () => {
		fake("kitty", "echo 42");
		expect(
			await outcome(drivers.kitty(5000).spawn({ layout: "tab" })),
		).toMatchObject({
			answered: { driverId: "kitty", value: "42", scope: "unix:@nowhere" },
		});
	}, 15_000);

	it("names the pane a wezterm that answers made", async () => {
		fake("wezterm", "echo 42");
		expect(
			await outcome(drivers.wezterm(5000).spawn({ layout: "tab" })),
		).toMatchObject({
			answered: { driverId: "wezterm", value: "42" },
		});
	}, 15_000);

	it("names the pane a tmux that answers made", async () => {
		fake("tmux", "echo %9");
		expect(
			await outcome(drivers.tmux(5000).spawn({ layout: "pane" })),
		).toMatchObject({
			answered: { driverId: "tmux", value: "%9", scope: "/nowhere/tmux" },
		});
	}, 15_000);

	it("names the pane a zellij that answers made", async () => {
		fake("zellij", "echo terminal_3");
		expect(
			await outcome(drivers.zellij(5000).spawn({ layout: "pane" })),
		).toMatchObject({
			answered: { driverId: "zellij", value: "terminal_3", scope: "nowhere" },
		});
	}, 15_000);

	it("sends kitty its text on stdin, so a backslash stays a backslash", async () => {
		const seen = join(bin, "seen");
		// Answers get-text with a prompt, and keeps what send-text is given.
		fake("kitty", `case "$4" in get-text) echo '$ ';; *) cat > ${seen};; esac`);
		await drivers
			.kitty(5000)
			.typeInto(handle("kitty", "1", "unix:@k"), "echo a\\nb\n");
		expect(readFileSync(seen, "utf8")).toBe("echo a\\nb\n");
	}, 15_000);
});

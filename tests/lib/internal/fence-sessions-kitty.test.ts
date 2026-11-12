/**
 * The sessions kitty takes remote control on a socket in the runtime
 * folder, `pi-sessions/kitty.sock`, from any process of the account
 * that reaches it, so it can read and type into every session window.
 * Core leaves the fence to keep fenced commands from it (ISXEG8,
 * 2026-11-12), so this proves that through a real bubblewrap rather
 * than leaving it to reading `LET_THROUGH`: a socket the fence lets
 * through is seen inside, beside it the sessions kitty's is not. Each
 * stands as a plain file, since the fence binds a path whatever it is
 * and a test folder's path is longer than a Unix socket's may be. It
 * skips only where no bubblewrap can make a namespace.
 */

import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fenceArgs } from "../../../lib/internal/fence.ts";

/** A bubblewrap on `PATH` that can make a namespace here, or nothing. */
function workingBwrap(): string | undefined {
	const found = spawnSync("bash", ["-c", "command -v bwrap"], {
		encoding: "utf8",
	}).stdout.trim();
	if (!found) return undefined;
	const tried = spawnSync(found, [
		"--unshare-user",
		"--ro-bind",
		"/",
		"/",
		"true",
	]);
	return tried.status === 0 ? found : undefined;
}

const bwrap = workingBwrap();

describe.skipIf(bwrap === undefined)(
	"the sessions kitty's socket, from inside the fence",
	() => {
		let base: string;
		let home: string;
		let runtimeDir: string;

		/** Whether `script` succeeds as a fenced command. */
		function fenced(script: string): boolean {
			const args = fenceArgs({ home, runtimeDir });
			const ran = spawnSync(
				bwrap ?? "bwrap",
				["--unshare-user", ...args, "sh", "-c", script],
				{ encoding: "utf8" },
			);
			return ran.status === 0;
		}

		beforeAll(() => {
			// Side by side, as /home and /run/user are: a runtime folder
			// inside the home would be bound back by the home's binds.
			base = realpathSync(mkdtempSync(join(tmpdir(), "fence-kitty-")));
			home = join(base, "home");
			mkdirSync(home);
			runtimeDir = join(base, "run");
			mkdirSync(join(runtimeDir, "pi-sessions"), {
				recursive: true,
				mode: 0o700,
			});
			writeFileSync(join(runtimeDir, "pi-agent.sock"), "");
			writeFileSync(join(runtimeDir, "pi-sessions", "kitty.sock"), "");
		});

		afterAll(() => {
			rmSync(base, { recursive: true, force: true });
		});

		it("sees a socket the fence lets through, so a missing one means kept out", () => {
			expect(
				fenced(`test -e ${join(runtimeDir, "pi-agent.sock")}`),
				"the SSH agent's proxy, which the fence lets through, wasn't seen inside",
			).toBe(true);
		});

		it("keeps the sessions kitty's socket out", () => {
			expect(
				fenced(`test -e ${join(runtimeDir, "pi-sessions", "kitty.sock")}`),
				"a fenced command can reach the sessions kitty's remote control",
			).toBe(false);
		});
	},
);

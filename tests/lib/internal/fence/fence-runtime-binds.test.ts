/**
 * What the fence binds back into its empty runtime folder, through a real
 * bubblewrap: read-only, so no fenced command can empty the SSH agent
 * proxy's folder and listen in the proxy's place for every other
 * session's signing; and what it leaves out, such as the compile caches
 * node runs from outside it. It skips only where no bubblewrap can make a
 * namespace, as inside another sandbox.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	compileFolderOf,
	RUNTIME_COMPILE,
} from "../../../../lib/internal/fence/compile-cache-place.ts";
import { fenceArgs } from "../../../../lib/internal/fence/fence.ts";

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
	"the proxy's folder in the fence's runtime folder",
	() => {
		let base = "";
		let home = "";
		let runtimeDir = "";
		let folder = "";
		let socket = "";
		let server: Server | undefined;

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

		beforeAll(async () => {
			// Not resolved, since a Unix socket's path may be at most 107
			// bytes and a temporary folder can sit behind a long link.
			base = mkdtempSync(join(tmpdir(), "frb-"));
			// Beside each other, as /home and /run/user are: a runtime folder
			// inside the home folder comes back with the home's own binds.
			home = join(base, "home");
			mkdirSync(home);
			runtimeDir = join(base, "run");
			folder = join(runtimeDir, "pi-agent");
			mkdirSync(folder, { recursive: true, mode: 0o700 });
			socket = join(folder, "agent.sock");
			const listening = createServer((client) => client.end());
			server = listening;
			await new Promise<void>((settle) => listening.listen(socket, settle));
		});

		afterAll(async () => {
			const listening = server;
			if (listening) await new Promise((settle) => listening.close(settle));
			rmSync(base, { recursive: true, force: true });
		});

		it("can't remove, move or add anything there, so the proxy's socket stays the proxy's", () => {
			const before = statSync(socket).ino;
			expect(
				fenced(`rm -f '${socket}'`),
				"the proxy's socket was removed",
			).toBe(false);
			expect(
				fenced(`mv '${socket}' '${socket}.old'`),
				"the proxy's socket was moved",
			).toBe(false);
			expect(
				fenced(`touch '${folder}/planted'`),
				"something was added beside it",
			).toBe(false);
			expect(
				statSync(socket).ino,
				"the socket outside isn't the one the proxy made",
			).toBe(before);
		});

		it("still sees the proxy's socket there", () => {
			expect(
				fenced(`test -S '${socket}'`),
				"the socket isn't there inside",
			).toBe(true);
		});

		it("sees no compiled code there, and what it writes there never reaches it", () => {
			// node runs what it reads back from pi-compile outside the fence.
			const host = compileFolderOf(
				"host",
				{ XDG_RUNTIME_DIR: runtimeDir, HOME: home },
				"linux",
				runtimeDir,
			);
			expect(host).toBe(join(runtimeDir, RUNTIME_COMPILE, "host"));
			expect(
				fenced(`test -e '${join(runtimeDir, RUNTIME_COMPILE)}'`),
				"the compile folder is there inside",
			).toBe(false);
			expect(
				fenced(
					`mkdir -p '${host}' && echo planted > '${host}/entry' && test -s '${host}/entry'`,
				),
				"the fenced command ran and wrote inside",
			).toBe(true);
			expect(
				existsSync(join(host, "entry")),
				"a fenced command wrote into the compile folder outside",
			).toBe(false);
		});
	},
);

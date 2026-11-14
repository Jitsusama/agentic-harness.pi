/**
 * A socket outside the fence's list, through a real Landlock: the fence
 * binds the whole disk, so a socket such as nix-offload's standing door
 * (`/run/nix-offload-standing.sock`, which hands builds to the standing
 * builders as the person) is seen inside, and only Landlock keeps a
 * fenced command from connecting to it (ISXEG8's condition for taking
 * the person off Nix's trusted users, 13 November). This serves real
 * sockets and connects from inside landrun with the fence's own rules:
 * one the fence lets through is reached, one beside it is refused. It
 * skips where landrun can't run, or where this test already runs under
 * a Landlock that refuses the socket let through.
 */

import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fenceRules, NEVER_THROUGH } from "../../../lib/internal/fence.ts";

/** A landrun on `PATH` that can lay a Landlock here, or nothing. */
function workingLandrun(): string | undefined {
	const found = spawnSync("bash", ["-c", "command -v landrun"], {
		encoding: "utf8",
	}).stdout.trim();
	if (!found) return undefined;
	const tried = spawnSync(found, ["--rwx", "/", "--", "true"]);
	return tried.status === 0 ? found : undefined;
}

const landrun = workingLandrun();

/**
 * systemd's credential service, which decrypts for any caller what its
 * account sealed, the login keyring's password among them.
 */
const CREDENTIALS = "/run/systemd/io.systemd.Credentials";

/** A script for node that exits 0 once it connects to its socket. */
const CONNECT = [
	"const s = require('node:net').connect(process.argv[1]);",
	"s.on('connect', () => process.exit(0));",
	"s.on('error', () => process.exit(2));",
].join(" ");

/** Whether a node, wrapped in `before`, connects to the socket at `path`. */
function connects(path: string, before: readonly string[]): Promise<boolean> {
	const [program, ...rest] = [...before, process.execPath, "-e", CONNECT];
	return new Promise((settle) => {
		execFile(program ?? "", [...rest, path], { timeout: 20_000 }, (error) =>
			settle(error === null),
		);
	});
}

/** A socket served at `path` until closed. */
function serve(path: string): Promise<Server> {
	return new Promise((settle, fail) => {
		const server = createServer((socket) => socket.end());
		server.once("error", fail);
		server.listen(path, () => settle(server));
	});
}

describe.skipIf(landrun === undefined)(
	"a socket the fence doesn't list, from inside its Landlock",
	() => {
		let base: string;
		let runtimeDir: string;
		let letThrough: string;
		let standing: string;
		const servers: Server[] = [];
		const fenced = () => [
			landrun ?? "landrun",
			...fenceRules({ home: base, runtimeDir }),
			"--",
		];

		beforeAll(async () => {
			// Not resolved, since a Unix socket's path may be at most 107
			// bytes and a temporary folder can sit behind a long link.
			base = mkdtempSync(join(tmpdir(), "fs-"));
			runtimeDir = join(base, "run");
			mkdirSync(runtimeDir, { mode: 0o700 });
			letThrough = join(runtimeDir, "pi-agent.sock");
			standing = join(base, "nix-offload-standing.sock");
			servers.push(await serve(letThrough), await serve(standing));
		});

		afterAll(async () => {
			await Promise.all(
				servers.map((server) => new Promise((settle) => server.close(settle))),
			);
			rmSync(base, { recursive: true, force: true });
		});

		it("keeps a fenced command from the standing builders' door, beside one it lets through", async (context) => {
			// A test run already fenced can't reach either: nothing here
			// would tell the fence's refusal from the one around it.
			if (!(await connects(letThrough, []))) context.skip();

			expect(
				await connects(letThrough, fenced()),
				"the SSH agent's proxy, which the fence lets through, wasn't reached",
			).toBe(true);
			expect(
				await connects(standing, fenced()),
				"a fenced command connected to a socket the fence doesn't list",
			).toBe(false);
		});

		it("names the standing builders' door among what never goes through", () => {
			expect(
				NEVER_THROUGH,
				"a change to the fence could let the standing door through unseen",
			).toContain("/run/nix-offload-standing.sock");
		});

		it("keeps a fenced command from systemd's credential service, which opens what the person sealed", async (context) => {
			// Only where the service runs and this test isn't already fenced
			// away from it, so the refusal seen is the fence's own.
			if (!(await connects(CREDENTIALS, []))) context.skip();

			expect(
				await connects(CREDENTIALS, fenced()),
				"a fenced command reached systemd's credential service",
			).toBe(false);
			expect(NEVER_THROUGH).toContain(CREDENTIALS);
		});
	},
);

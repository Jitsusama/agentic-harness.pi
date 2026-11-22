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
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	fenceRules,
	NEVER_THROUGH,
} from "../../../../lib/internal/fence/fence.ts";
import { strictRules } from "../../../../lib/internal/sandbox/strict-rules.ts";

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

/**
 * How a node ends trying its socket: it connected, or its connect was
 * refused access, which is how Landlock refuses one (EACCES, as landrun
 * 0.1.17 on Linux 7.3 gives it; a missing socket is ENOENT). Any other
 * end (another connect error, landrun refusing its arguments, which it
 * exits 1 for, node not starting under the rules, the run timing out)
 * is neither, so a broken fence or a gone socket never reads as one
 * kept shut.
 */
const CONNECTED = 0;
const DENIED = 13;
const OTHERWISE = 3;

/** A script for node that exits with how its connect to its socket went. */
const CONNECT = [
	"const s = require('node:net').connect(process.argv[1]);",
	`s.on('connect', () => process.exit(${CONNECTED}));`,
	`s.on('error', (e) => process.exit(e.code === 'EACCES' ? ${DENIED} : ${OTHERWISE}));`,
].join(" ");

/** How a node, wrapped in `before`, ended trying the socket at `path`. */
function tries(
	path: string,
	before: readonly string[],
): Promise<number | string | null> {
	const [program, ...rest] = [...before, process.execPath, "-e", CONNECT];
	return new Promise((settle) => {
		execFile(program ?? "", [...rest, path], { timeout: 20_000 }, (error) =>
			settle(error === null ? CONNECTED : (error.code ?? error.signal ?? null)),
		);
	});
}

/** Whether a node, wrapped in `before`, connects to the socket at `path`. */
async function connects(
	path: string,
	before: readonly string[],
): Promise<boolean> {
	return (await tries(path, before)) === CONNECTED;
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
		let inFolder: string;
		let standing: string;
		let eero: string;
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
			mkdirSync(join(runtimeDir, "pi-agent"), { mode: 0o700 });
			inFolder = join(runtimeDir, "pi-agent", "agent.sock");
			standing = join(base, "nix-offload-standing.sock");
			mkdirSync(join(runtimeDir, "eero"), { mode: 0o700 });
			eero = join(runtimeDir, "eero", "socket");
			servers.push(
				await serve(letThrough),
				await serve(inFolder),
				await serve(standing),
				await serve(eero),
			);
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
				await tries(standing, fenced()),
				"a fenced command connected to a socket the fence doesn't list, or never tried",
			).toBe(DENIED);
		});

		it("lets a fenced command reach the proxy's socket in its own folder, which the rule names as a folder", async (context) => {
			if (!(await connects(inFolder, []))) context.skip();

			expect(
				await connects(inFolder, fenced()),
				"the proxy's socket in its folder wasn't reached through the folder's rule",
			).toBe(true);
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
				await tries(letThrough, fenced()),
				"the SSH agent's proxy, which the fence lets through, wasn't reached",
			).toBe(CONNECTED);
			expect(
				await tries(CREDENTIALS, fenced()),
				"a fenced command reached systemd's credential service, or never tried",
			).toBe(DENIED);
			expect(NEVER_THROUGH).toContain(CREDENTIALS);
		});

		it("keeps a fenced command from the eero daemon's socket, which changes the home network", async (context) => {
			if (!(await connects(eero, []))) context.skip();

			// The same rules with one more, on the socket's folder, reach it,
			// so its refusal below comes from no rule naming it or its folder,
			// not from a fence that never ran or anything else about the path.
			expect(
				await tries(eero, [
					landrun ?? "landrun",
					...fenceRules({ home: base, runtimeDir }),
					"--unix",
					join(runtimeDir, "eero"),
					"--",
				]),
				"the eero daemon's socket wasn't reached with a rule on its folder",
			).toBe(CONNECTED);
			// The list below keeps nothing out, but names it for fence-args'
			// test and the preflight to check.
			expect(
				await tries(eero, fenced()),
				"a fenced command connected to the eero daemon's socket, or never tried",
			).toBe(DENIED);
			expect(
				NEVER_THROUGH,
				"the list names another path than the socket this proves shut",
			).toContain(relative(runtimeDir, eero));
		});

		it("keeps a strict command from the eero daemon's socket, with no tmpfs over the runtime folder", async (context) => {
			if (!(await connects(eero, []))) context.skip();

			// A strict session is landrun alone, so the socket stays where it
			// is and only Landlock keeps it shut; the same rules with one on
			// its folder reach it, so the refusal is theirs.
			const strict = strictRules({ home: base, runtimeDir, cwd: base }).flat();
			expect(
				await tries(eero, [
					landrun ?? "landrun",
					...strict,
					"--unix",
					join(runtimeDir, "eero"),
					"--",
				]),
				"the eero daemon's socket wasn't reached by a strict command with a rule on its folder",
			).toBe(CONNECTED);
			expect(
				await tries(eero, [landrun ?? "landrun", ...strict, "--"]),
				"a strict command connected to the eero daemon's socket, or never tried",
			).toBe(DENIED);
		});
	},
);

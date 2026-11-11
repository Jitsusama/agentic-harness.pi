/**
 * host-join run as a window runs it, by node in a sealed environment of
 * its own: under no holder, a view or a release runs what comes next
 * itself and ends as that does, while a move, which only a holder can
 * carry on past, is refused. A holder's variables inherited from a shell
 * that runs under some other holder don't make it held: only a holder
 * whose record names host-join's own process takes its next words.
 */

import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PARKED_EXIT } from "../../lib/internal/session/park.ts";

const run = promisify(execFile);
const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "host-join.ts");
const PLAIN_PI = ["sh", "-c", "echo carried on as plain pi; exit 4"];

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A mycelium holder's files, as its record, wake and next command sit side by side. */
interface Holder {
	readonly record: string;
	readonly wake: string;
	readonly again: string;
}

/** A holder's folder in a fresh home, its record not yet written. */
function holderIn(home: string): Holder {
	const dir = join(home, "run", "mycelium", "work.held");
	mkdirSync(dir, { recursive: true });
	return {
		record: join(dir, "7df34a34.json"),
		wake: join(dir, "7df34a34.wake"),
		again: join(dir, "7df34a34.again"),
	};
}

/** A home of its own for one run. */
function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "h2-host-join-"));
	made.push(dir);
	return dir;
}

/**
 * host-join's output and exit code, run by node under a sealed `env` in
 * `at`, under `holder`'s variables when given, through `sh` so the shell
 * can name its own pid before it becomes node.
 */
async function hostJoin(
	args: readonly string[],
	at: string = home(),
	holder?: { readonly files: Holder; readonly recordsSelf: boolean },
) {
	const env = {
		PATH: process.env.PATH,
		HOME: at,
		TMPDIR: at,
		XDG_RUNTIME_DIR: join(at, "run"),
		XDG_STATE_HOME: join(at, "state"),
		...(holder
			? {
					MYCELIUM_WAKE: holder.files.wake,
					MYCELIUM_AGAIN: holder.files.again,
				}
			: {}),
	};
	// A holder runs its program itself, so its record names that pid: the
	// shell writes its own, then becomes node with it.
	const names = holder?.recordsSelf
		? `printf '{"id":"7df34a34","pid":%s}' "$$" > "$0"; `
		: "";
	return run(
		"sh",
		[
			"-c",
			`${names}exec "$@"`,
			holder?.files.record ?? "sh",
			process.execPath,
			"--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
			SCRIPT,
			...args,
		],
		{ env, timeout: 20_000 },
	).then(
		(done) => ({ code: 0, stdout: done.stdout, stderr: done.stderr }),
		(failed: { code?: number; stdout?: string; stderr?: string }) => ({
			code: failed.code ?? -1,
			stdout: failed.stdout ?? "",
			stderr: failed.stderr ?? "",
		}),
	);
}

describe("host-join under no holder", () => {
	it("runs plain pi itself for a view no host holds, ending as it ends", async () => {
		const joined = await hostJoin([
			"--view",
			"--session",
			"01a1",
			"--",
			...PLAIN_PI,
		]);
		expect(joined.stdout, "the view ran plain pi itself").toBe(
			"carried on as plain pi\n",
		);
		expect(joined.code, "it ended as plain pi ended").toBe(4);
	});

	it("runs a view itself under a holder's variables it inherited from another program's shell, leaving that holder's files alone", async () => {
		const at = home();
		const files = holderIn(at);
		// The holder of the pi whose shell opened the window: it runs that pi.
		writeFileSync(files.record, JSON.stringify({ id: "7df34a34", pid: 1 }));
		const joined = await hostJoin(
			["--view", "--session", "01a1", "--", ...PLAIN_PI],
			at,
			{ files, recordsSelf: false },
		);
		expect(joined.stdout, "the view ran plain pi itself").toBe(
			"carried on as plain pi\n",
		);
		expect(joined.code, "it ended as plain pi ended").toBe(4);
		expect(
			existsSync(files.wake),
			"no wake was left beside the other program's holder",
		).toBe(false);
		expect(
			existsSync(files.again),
			"no next command was named to the other program's holder",
		).toBe(false);
	});

	it("refuses a move, which only a holder carries on past", async () => {
		const joined = await hostJoin(["--session", "01a1", "--", ...PLAIN_PI]);
		expect(joined.code).not.toBe(0);
		expect(joined.stdout).toBe("");
		expect(joined.stderr).toContain("runs under a mycelium holder");
	});
});

describe("host-join under its own holder", () => {
	it("names its next words to the holder and exits as a park does", async () => {
		const at = home();
		const files = holderIn(at);
		const joined = await hostJoin(
			["--view", "--session", "01a1", "--", ...PLAIN_PI],
			at,
			{ files, recordsSelf: true },
		);
		expect(joined.stdout, "it ran nothing itself").toBe("");
		expect(joined.code, "it exited as a park does").toBe(PARKED_EXIT);
		expect(
			JSON.parse(readFileSync(files.again, "utf8")),
			"the holder starts plain pi next",
		).toEqual(PLAIN_PI);
		expect(
			existsSync(files.wake),
			"its wake tells the holder to start it at once",
		).toBe(true);
	});
});

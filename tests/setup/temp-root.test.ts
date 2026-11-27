/**
 * Where a test run's temp directory goes: under the host's own temporary
 * folder, except on a Mac whose folder is its own default, which sits so
 * deep under /var/folders that the sockets the host's tests make there
 * run past the 104 bytes a Unix socket's path may take.
 */

import { spawnSync } from "node:child_process";
import type * as Fs from "node:fs";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readlinkSync,
	rmdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import {
	mkdir,
	mkdtemp,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import setup, {
	FRESH_MS,
	runRootBase,
	SOCKET_ROOT,
	STALE_MS,
	STARTING_MS,
	type Sweeper,
	sweepShortFolders,
} from "./temp-root.ts";

// Named rather than made or removed, so the setup's own run is read
// without writing where this machine's /tmp may not let a test write.
// The machine's own /tmp reads as empty, so no sweep here counts another
// run's folder among a case's removals. Removing an empty folder stays
// real, so one with anything inside refuses as it would.
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof Fs>();
	return {
		...fs,
		mkdirSync: vi.fn(),
		mkdtempSync: vi.fn((prefix: string) => `${prefix}XXXXXX`),
		rmSync: vi.fn(),
		rmdirSync: vi.fn(fs.rmdirSync),
		utimesSync: vi.fn(),
		writeFileSync: vi.fn(),
		readdirSync: vi.fn((path: string) =>
			path === "/tmp" ? [] : fs.readdirSync(path),
		),
	};
});

/** A Mac's own TMPDIR, as `os.tmpdir()` gives it. */
const MAC_TMPDIR = "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T";

/** What the setup names under a session's TMPDIR, as mocked here. */
const RUN_ROOT = "/tmp/pi-quest-x/vitest-run-XXXXXX";
const SHORT = "/tmp/vs-XXXXXX";
const REMOVED = { recursive: true, force: true };

/** This process's pid namespace as Linux names it, or none, as on a Mac. */
function ownNamespace(): string {
	try {
		return readlinkSync("/proc/self/ns/pid");
	} catch {
		return "";
	}
}

/** An error as the file system raises it, with its code. */
function fsError(code: string): Error {
	return Object.assign(new Error(`${code}: refused`), { code });
}

/** Make the short folder fail with `code`, as `/tmp` refusing it would. */
function refuseShortFolder(code: string): void {
	vi.mocked(mkdtempSync).mockImplementation((prefix) => {
		if (String(prefix).startsWith("/tmp/vs-")) throw fsError(code);
		return `${prefix}XXXXXX`;
	});
}

/** Run `body` with a session's TMPDIR, putting the mocks back after. */
function inSession(body: () => void): void {
	vi.stubEnv("TMPDIR", "/tmp/pi-quest-x");
	// So this worker's own short folder comes back once the case ends.
	vi.stubEnv(SOCKET_ROOT, process.env[SOCKET_ROOT]);
	vi.mocked(rmSync).mockClear();
	vi.mocked(writeFileSync).mockClear();
	try {
		body();
	} finally {
		vi.mocked(mkdtempSync).mockImplementation((prefix) => `${prefix}XXXXXX`);
		vi.mocked(rmSync).mockImplementation(() => {});
		vi.unstubAllEnvs();
	}
}

describe("a test run's temp root", () => {
	it("goes under /tmp on a Mac, whose own TMPDIR is too deep for a socket", () => {
		expect(runRootBase("darwin", MAC_TMPDIR)).toBe("/tmp");
		expect(runRootBase("darwin", `/private${MAC_TMPDIR}`), "as resolved").toBe(
			"/tmp",
		);
	});

	// A session's own scratch may be the one place a fenced run can write.
	it("stays under a TMPDIR a session set on a Mac", () => {
		expect(runRootBase("darwin", "/tmp/pi-quest-x")).toBe("/tmp/pi-quest-x");
	});

	it("stays under the host's own temporary folder on Linux", () => {
		expect(runRootBase("linux", "/tmp/pi-quest-x")).toBe("/tmp/pi-quest-x");
	});

	it("is where the run's setup makes its directory", () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "darwin" });
		vi.stubEnv("TMPDIR", MAC_TMPDIR);
		vi.stubEnv(SOCKET_ROOT, process.env[SOCKET_ROOT]);
		try {
			const teardown = setup();
			expect(vi.mocked(mkdtempSync)).toHaveBeenCalledWith("/tmp/vitest-run-");
			expect(process.env.TMPDIR, "the run's TMPDIR").toBe(
				"/tmp/vitest-run-XXXXXX",
			);
			teardown();
			expect(process.env.TMPDIR, "given back at its end").toBe(MAC_TMPDIR);
		} finally {
			if (platform !== undefined)
				Object.defineProperty(process, "platform", platform);
			vi.unstubAllEnvs();
		}
	});

	// A session's TMPDIR, made 18 bytes longer by the run's own folder,
	// leaves a socket test nowhere short to listen.
	it("names a short folder for sockets under /tmp, naming its run, and removes it at its end", () => {
		inSession(() => {
			// Unset, as at a run's start, so the end has nothing to give back.
			vi.stubEnv(SOCKET_ROOT, undefined);
			vi.mocked(readdirSync).mockClear();
			vi.mocked(mkdtempSync).mockClear();
			const teardown = setup();
			expect(process.env[SOCKET_ROOT], "while the run lasts").toBe(SHORT);
			expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(
				`${SHORT}/run.pid`,
				`${process.pid}\n${ownNamespace()}\n`,
			);
			const swept = vi
				.mocked(readdirSync)
				.mock.calls.findIndex(([path]) => path === "/tmp");
			const made = vi
				.mocked(mkdtempSync)
				.mock.calls.findIndex(([prefix]) => prefix === "/tmp/vs-");
			expect(
				vi.mocked(readdirSync).mock.invocationCallOrder[swept] ??
					Number.POSITIVE_INFINITY,
				"/tmp swept before its own folder is made",
			).toBeLessThan(
				vi.mocked(mkdtempSync).mock.invocationCallOrder[made] ??
					Number.NEGATIVE_INFINITY,
			);
			teardown();
			expect(process.env[SOCKET_ROOT], "after it").toBeUndefined();
			expect(vi.mocked(rmSync).mock.calls).toEqual([
				[SHORT, REMOVED],
				[RUN_ROOT, REMOVED],
			]);
		});
	});

	it.each([
		[RUN_ROOT, SHORT],
		[SHORT, RUN_ROOT],
	])("removes the other folder when %s won't go", (stuck, other) => {
		inSession(() => {
			const teardown = setup();
			vi.mocked(rmSync).mockImplementation((path) => {
				if (path === stuck) throw fsError("EACCES");
			});
			expect(() => teardown(), "the failure still shows").toThrow(/EACCES/);
			expect(vi.mocked(rmSync)).toHaveBeenCalledWith(other, REMOVED);
		});
	});

	// Its age is its last change, which only a socket test's own folder
	// makes, so a watch run left a day would read as gone to any sweep
	// that can't judge its pid, as every other fenced command's on Linux.
	it("keeps its short folder fresh while the run lasts, and stops at its end", () => {
		expect(FRESH_MS * 2, "fresh well inside the day").toBeLessThan(STALE_MS);
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const timers = vi.spyOn(globalThis, "setInterval");
		try {
			inSession(() => {
				vi.mocked(utimesSync).mockClear();
				const teardown = setup();
				const fresh = timers.mock.results[0]?.value as NodeJS.Timeout;
				expect(fresh.hasRef(), "it never keeps a run going").toBe(false);
				vi.advanceTimersByTime(FRESH_MS);
				const [[path, atime, mtime] = []] = vi.mocked(utimesSync).mock.calls;
				expect(path, "once a while has passed").toBe(SHORT);
				expect(
					Math.abs(Number(mtime) - Date.now()),
					"dated now, so it reads as fresh",
				).toBeLessThan(60_000);
				expect(atime).toEqual(mtime);
				teardown();
				vi.advanceTimersByTime(FRESH_MS);
				expect(
					vi.mocked(utimesSync),
					"not after its end",
				).toHaveBeenCalledTimes(1);
			});
		} finally {
			timers.mockRestore();
			vi.useRealTimers();
		}
	});

	// A run asleep or stopped past STALE_MS fires no timer, so a sweep that
	// can't judge its pid may take its folder before the next touch.
	it("makes its short folder again, naming its run, where a sweep took it", () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			inSession(() => {
				const teardown = setup();
				vi.mocked(writeFileSync).mockClear();
				vi.mocked(mkdirSync).mockClear();
				vi.mocked(utimesSync).mockImplementationOnce(() => {
					throw fsError("ENOENT");
				});
				vi.advanceTimersByTime(FRESH_MS);
				expect(vi.mocked(mkdirSync).mock.calls).toEqual([
					[SHORT, { mode: 0o700 }],
				]);
				expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(
					`${SHORT}/run.pid`,
					`${process.pid}\n${ownNamespace()}\n`,
				);
				// Another run's, made at the name in between, isn't this run's.
				vi.mocked(writeFileSync).mockClear();
				vi.mocked(utimesSync).mockImplementationOnce(() => {
					throw fsError("ENOENT");
				});
				vi.mocked(mkdirSync).mockImplementationOnce(() => {
					throw fsError("EEXIST");
				});
				vi.advanceTimersByTime(FRESH_MS);
				expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
				teardown();
			});
		} finally {
			vi.useRealTimers();
		}
	});

	// As under the sandbox, which grants a fenced run only its TMPDIR, or a
	// builder with no /tmp at all.
	it.each(["EACCES", "ENOENT", "ENOTDIR"])(
		"names none where /tmp may not be written or isn't there (%s), dropping one it inherited, and still runs",
		(code) => {
			const warned = vi
				.spyOn(process.stderr, "write")
				.mockImplementation(() => true);
			inSession(() => {
				vi.stubEnv(SOCKET_ROOT, "/tmp/vs-outer-run");
				refuseShortFolder(code);
				const teardown = setup();
				// The sandbox refuses /tmp on every fenced run, which is no fault;
				// a /tmp that isn't there is the host's, and named.
				expect(
					warned.mock.calls.map(([said]) => String(said)),
					"what's said of /tmp",
				).toEqual(
					code === "EACCES"
						? []
						: [`no short folder for sockets: /tmp gave ${code}\n`],
				);
				warned.mockRestore();
				expect(process.env[SOCKET_ROOT], "no short folder").toBeUndefined();
				expect(process.env.TMPDIR, "the run's TMPDIR").toBe(RUN_ROOT);
				teardown();
				expect(vi.mocked(rmSync).mock.calls, "only the run root").toEqual([
					[RUN_ROOT, REMOVED],
				]);
				expect(process.env[SOCKET_ROOT], "given back").toBe(
					"/tmp/vs-outer-run",
				);
			});
		},
	);

	it("fails the run on any other error making its short folder, leaving nothing it made", () => {
		inSession(() => {
			refuseShortFolder("ENOSPC");
			expect(() => setup()).toThrow(/ENOSPC/);
			expect(vi.mocked(rmSync).mock.calls).toEqual([[RUN_ROOT, REMOVED]]);
			expect(process.env.TMPDIR, "given back").toBe("/tmp/pi-quest-x");
		});
	});

	// A folder with no run file reads as a run's still starting, so one
	// left by a failed write would wait out a sweep's hour.
	it("removes its short folder and root when it can't name its run", () => {
		inSession(() => {
			vi.mocked(writeFileSync).mockImplementationOnce(() => {
				throw fsError("ENOSPC");
			});
			expect(() => setup()).toThrow(/ENOSPC/);
			expect(vi.mocked(rmSync).mock.calls).toEqual([
				[SHORT, REMOVED],
				[RUN_ROOT, REMOVED],
			]);
			expect(process.env.TMPDIR, "given back").toBe("/tmp/pi-quest-x");
		});
	});
});

describe("a sweep of short folders", () => {
	/** The namespaces a case names: the sweep's own, and another's. */
	const HERE = "pid:[4026531836]";
	const ELSEWHERE = "pid:[4026532999]";
	const HOUR = 60 * 60 * 1000;

	interface Planted {
		readonly pid?: number;
		readonly namespace?: string;
		readonly ageMs?: number;
	}

	/** A folder in `parent` as a run would leave it, `ageMs` old. */
	async function plant(parent: string, name: string, run: Planted) {
		const folder = join(parent, name);
		await mkdir(folder);
		if (run.pid !== undefined)
			await writeFile(
				join(folder, "run.pid"),
				`${run.pid}\n${run.namespace ?? HERE}\n`,
			);
		await age(folder, run.ageMs ?? 0);
		return folder;
	}

	/** Date `path` `ageMs` back. */
	async function age(path: string, ageMs: number) {
		const at = (Date.now() - ageMs) / 1000;
		await utimes(path, at, at);
	}

	/** Whom a sweep of `parent` by `sweeper` removes, by name. */
	function removedBy(parent: string, sweeper: Partial<Sweeper> = {}): string[] {
		vi.mocked(rmSync).mockClear();
		vi.mocked(rmdirSync).mockClear();
		sweepShortFolders(parent, { namespace: HERE, now: Date.now(), ...sweeper });
		const emptied = vi
			.mocked(rmdirSync)
			.mock.calls.filter(
				(_, call) => vi.mocked(rmdirSync).mock.results[call]?.type === "return",
			);
		return [...vi.mocked(rmSync).mock.calls, ...emptied]
			.map(([path]) => String(path).slice(parent.length + 1))
			.sort();
	}

	it("removes this account's whose run is gone, judging a pid only in its own namespace, and those it can't judge past their time", async () => {
		const parent = await mkdtemp(join(tmpdir(), "sweep-"));
		const away = await mkdtemp(join(tmpdir(), "sweep-away-"));
		const gone = spawnSync("true").pid ?? 0;
		const old = { ageMs: STALE_MS + HOUR };
		try {
			await plant(parent, "vs-gone00", { pid: gone });
			await plant(parent, "vs-live00", { pid: process.pid });
			// A watch run lasts as long as the developer leaves it.
			await plant(parent, "vs-liveOd", { pid: process.pid, ...old });
			// Its gone pid names nothing here, so it may be a live fenced run's.
			await plant(parent, "vs-away00", { pid: gone, namespace: ELSEWHERE });
			await plant(parent, "vs-awayMd", {
				pid: gone,
				namespace: ELSEWHERE,
				ageMs: STALE_MS - HOUR,
			});
			await plant(parent, "vs-awayOd", {
				pid: gone,
				namespace: ELSEWHERE,
				...old,
			});
			await plant(parent, "vs-start0", {});
			await plant(parent, "vs-startM", { ageMs: STARTING_MS - HOUR / 4 });
			await plant(parent, "vs-unnamd", { ageMs: STARTING_MS + HOUR });
			// A run killed between making its run file and writing it.
			for (const [name, ageMs] of [
				["vs-torn00", 0],
				["vs-tornOd", STARTING_MS + HOUR],
			] as const) {
				const torn = await plant(parent, name, {});
				await writeFile(join(torn, "run.pid"), "");
				await age(torn, ageMs);
			}
			// Torn, with something else inside a sweep mustn't change.
			const tornFull = await plant(parent, "vs-tornFl", {});
			await writeFile(join(tornFull, "run.pid"), "");
			await writeFile(join(tornFull, "notes"), "kept");
			await age(tornFull, STARTING_MS + HOUR);
			// No run's file, and something inside a sweep mustn't guess at.
			const full = await plant(parent, "vs-fullOd", {});
			await writeFile(join(full, "notes"), "kept");
			await age(full, old.ageMs);
			const odd = await plant(parent, "vs-badrec", {});
			await writeFile(join(odd, "run.pid"), `${gone} and more\n`);
			await age(odd, old.ageMs);
			// The prefix alone, as a developer's own folder might be named.
			await plant(parent, "vs-notes", { pid: gone, ...old });
			await plant(parent, "other-gone", { pid: gone });
			const file = join(parent, "vs-afile0");
			await writeFile(file, String(gone));
			await age(file, old.ageMs);
			// A link to a gone run's folder, which a sweep through it would take.
			await symlink(
				await plant(away, "vs-target", { pid: gone, ...old }),
				join(parent, "vs-link00"),
			);

			expect(removedBy(parent)).toEqual([
				"vs-awayOd",
				"vs-gone00",
				"vs-tornOd",
				"vs-unnamd",
			]);
			expect(
				existsSync(join(tornFull, "run.pid")),
				"a folder it keeps keeps its run file",
			).toBe(true);
		} finally {
			await rm(parent, { recursive: true, force: true });
			await rm(away, { recursive: true, force: true });
		}
	});

	// A pid reused by another account's process: the probe is refused
	// rather than answered, so the run may still be there.
	it("keeps a folder whose pid it may not probe", async () => {
		const parent = await mkdtemp(join(tmpdir(), "sweep-"));
		const gone = spawnSync("true").pid ?? 0;
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {
			throw fsError("EPERM");
		});
		try {
			await plant(parent, "vs-perm00", { pid: gone });

			expect(removedBy(parent)).toEqual([]);
		} finally {
			kill.mockRestore();
			await rm(parent, { recursive: true, force: true });
		}
	});

	// On Linux every process has a namespace, so a run naming none read no
	// /proc, and its pid may be any namespace's.
	it.each([
		["linux", "keeps", "new", 0, []],
		["linux", "keeps", "under a day old", STALE_MS - HOUR, []],
		["linux", "removes", "a day old", STALE_MS + HOUR, ["vs-empty0"]],
		["darwin", "removes", "new", 0, ["vs-empty0"]],
	] as const)(
		"on %s, %s a gone pid written with no namespace, %s",
		async (platform, _, _old, ageMs, removed) => {
			const parent = await mkdtemp(join(tmpdir(), "sweep-"));
			const gone = spawnSync("true").pid ?? 0;
			try {
				await plant(parent, "vs-empty0", { pid: gone, namespace: "", ageMs });

				expect(removedBy(parent, { namespace: "", platform })).toEqual(removed);
			} finally {
				await rm(parent, { recursive: true, force: true });
			}
		},
	);

	it("leaves another account's folders alone", async () => {
		const parent = await mkdtemp(join(tmpdir(), "sweep-"));
		const gone = spawnSync("true").pid ?? 0;
		const uid = process.getuid?.() ?? 0;
		const getuid = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
		try {
			await plant(parent, "vs-gone00", { pid: gone });
			await plant(parent, "vs-longgo", {
				pid: gone,
				namespace: ELSEWHERE,
				ageMs: STALE_MS + HOUR,
			});
			await plant(parent, "vs-unnamd", { ageMs: STARTING_MS + HOUR });

			expect(removedBy(parent)).toEqual([]);
		} finally {
			getuid.mockRestore();
			await rm(parent, { recursive: true, force: true });
		}
	});

	// What the setup writes and what its sweep judges by must agree.
	it("judges by this process's own namespace when none is named", async () => {
		const parent = await mkdtemp(join(tmpdir(), "sweep-"));
		const gone = spawnSync("true").pid ?? 0;
		try {
			await plant(parent, "vs-gone00", {
				pid: gone,
				namespace: ownNamespace(),
			});
			vi.mocked(rmSync).mockClear();

			sweepShortFolders(parent);

			expect(vi.mocked(rmSync).mock.calls).toEqual([
				[join(parent, "vs-gone00"), REMOVED],
			]);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	it("does nothing where the folder can't be read", () => {
		vi.mocked(rmSync).mockClear();
		sweepShortFolders(join(tmpdir(), "no-such-folder"));
		expect(vi.mocked(rmSync)).not.toHaveBeenCalled();
	});
});

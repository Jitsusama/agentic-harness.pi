/**
 * Where a test run's temp directory goes: under the host's own temporary
 * folder, except on a Mac whose folder is its own default, which sits so
 * deep under /var/folders that the sockets the host's tests make there
 * run past the 104 bytes a Unix socket's path may take.
 */

import { spawnSync } from "node:child_process";
import type * as Fs from "node:fs";
import {
	mkdtempSync,
	readdirSync,
	readlinkSync,
	rmSync,
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
	runRootBase,
	SOCKET_ROOT,
	STALE_MS,
	STARTING_MS,
	sweepShortFolders,
} from "./temp-root.ts";

// Named rather than made or removed, so the setup's own run is read
// without writing where this machine's /tmp may not let a test write.
// The machine's own /tmp reads as empty, so no sweep here counts another
// run's folder among a case's removals.
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof Fs>();
	return {
		...fs,
		mkdtempSync: vi.fn((prefix: string) => `${prefix}XXXXXX`),
		rmSync: vi.fn(),
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

	// As under the sandbox, which grants a fenced run only its TMPDIR.
	it("names none where /tmp may not be written, dropping one it inherited, and still runs", () => {
		inSession(() => {
			vi.stubEnv(SOCKET_ROOT, "/tmp/vs-outer-run");
			refuseShortFolder("EACCES");
			const teardown = setup();
			expect(process.env[SOCKET_ROOT], "no short folder").toBeUndefined();
			expect(process.env.TMPDIR, "the run's TMPDIR").toBe(RUN_ROOT);
			teardown();
			expect(vi.mocked(rmSync).mock.calls, "only the run root").toEqual([
				[RUN_ROOT, REMOVED],
			]);
			expect(process.env[SOCKET_ROOT], "given back").toBe("/tmp/vs-outer-run");
		});
	});

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
		const at = (Date.now() - (run.ageMs ?? 0)) / 1000;
		await utimes(folder, at, at);
		return folder;
	}

	/** Whom a sweep of `parent` removes, by name. */
	function removedBy(parent: string, namespace = HERE): string[] {
		vi.mocked(rmSync).mockClear();
		sweepShortFolders(parent, { namespace, now: Date.now() });
		return vi
			.mocked(rmSync)
			.mock.calls.map(([path]) => String(path).slice(parent.length + 1))
			.sort();
	}

	it("removes this account's whose run is gone, judging a pid only in its own namespace, and any past its time", async () => {
		const parent = await mkdtemp(join(tmpdir(), "sweep-"));
		const away = await mkdtemp(join(tmpdir(), "sweep-away-"));
		const gone = spawnSync("true").pid ?? 0;
		try {
			await plant(parent, "vs-gone", { pid: gone });
			await plant(parent, "vs-live", { pid: process.pid });
			// Pid 1 is another account's to a runner not root, so the probe is
			// refused rather than answered: a pid reused by someone else.
			await plant(parent, "vs-reused", { pid: 1 });
			await plant(parent, "vs-reused-long-ago", {
				pid: process.pid,
				ageMs: STALE_MS + HOUR,
			});
			// Its gone pid names nothing here, so it may be a live fenced run's.
			await plant(parent, "vs-elsewhere", { pid: gone, namespace: ELSEWHERE });
			await plant(parent, "vs-elsewhere-long-ago", {
				pid: gone,
				namespace: ELSEWHERE,
				ageMs: STALE_MS + HOUR,
			});
			await plant(parent, "vs-starting", {});
			await plant(parent, "vs-never-named", { ageMs: STARTING_MS + HOUR });
			await plant(parent, "other-gone", { pid: gone });
			const file = join(parent, "vs-a-file");
			await writeFile(file, String(gone));
			const old = (Date.now() - STALE_MS - HOUR) / 1000;
			await utimes(file, old, old);
			// A link to a gone run's folder, which a sweep through it would take.
			await symlink(
				await plant(away, "vs-target", { pid: gone, ageMs: STALE_MS + HOUR }),
				join(parent, "vs-link"),
			);

			expect(removedBy(parent)).toEqual([
				"vs-elsewhere-long-ago",
				"vs-gone",
				"vs-never-named",
				"vs-reused-long-ago",
			]);
		} finally {
			await rm(parent, { recursive: true, force: true });
			await rm(away, { recursive: true, force: true });
		}
	});

	it("leaves another account's folders alone", async () => {
		const parent = await mkdtemp(join(tmpdir(), "sweep-"));
		const gone = spawnSync("true").pid ?? 0;
		const uid = process.getuid?.() ?? 0;
		const getuid = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
		try {
			await plant(parent, "vs-gone", { pid: gone });
			await plant(parent, "vs-long-ago", { ageMs: STALE_MS + HOUR });

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
			await plant(parent, "vs-gone", { pid: gone, namespace: ownNamespace() });
			vi.mocked(rmSync).mockClear();

			sweepShortFolders(parent);

			expect(vi.mocked(rmSync).mock.calls).toEqual([
				[join(parent, "vs-gone"), REMOVED],
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

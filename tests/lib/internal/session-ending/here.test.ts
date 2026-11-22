/**
 * What this machine knows of itself that spares its own sessions: a
 * log-out that leaves the user's services running, read from logind,
 * and the sessions whose presence says they parked, read from every
 * realm's presences, while their marker from this boot says so too.
 * Anything that can't be read spares nothing.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Exec, ExecResult } from "../../../../lib/core/exec/index.ts";
import {
	type Parked,
	parkedPath,
	parkFolder,
	writeParked,
} from "../../../../lib/internal/session/park.ts";
import {
	logOutSpares,
	markedThisBoot,
	parkedHere as parkedHereAt,
	runningInHosts,
	withinPatience,
} from "../../../../lib/internal/session-ending/here.ts";

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const missing: ExecResult = { code: 127, stdout: "", stderr: "not found" };

/** An exec answering each command by its name, and missing otherwise. */
const answering =
	(answers: Record<string, ExecResult | (() => never)>): Exec =>
	async (command) => {
		const answer = answers[command];
		if (typeof answer === "function") return answer();
		return answer ?? missing;
	};

describe("whether a log-out here leaves the user's services running", () => {
	const lingering = ok("yes\n");
	const sparing = ok("b false\n");

	it("does when the user lingers and logind kills no user processes", async () => {
		const exec = answering({ loginctl: lingering, busctl: sparing });

		expect(
			await logOutSpares(exec, "1000"),
			"a lingering user's services outlive a log-out",
		).toBe(true);
	});

	it("doesn't when the user doesn't linger", async () => {
		const exec = answering({ loginctl: ok("no\n"), busctl: sparing });

		expect(
			await logOutSpares(exec, "1000"),
			"a user who doesn't linger loses its services",
		).toBe(false);
	});

	it("doesn't when logind kills user processes at a log-out", async () => {
		const exec = answering({ loginctl: lingering, busctl: ok("b true\n") });

		expect(
			await logOutSpares(exec, "1000"),
			"logind kills what the user left running",
		).toBe(false);
	});

	it("doesn't where logind can't be asked, as on a Mac", async () => {
		const failing = answering({});
		const throwing = answering({
			loginctl: () => {
				throw new Error("spawn loginctl ENOENT");
			},
			busctl: sparing,
		});

		expect(await logOutSpares(failing, "1000"), "no logind").toBe(false);
		expect(await logOutSpares(throwing, "1000"), "a spawn that throws").toBe(
			false,
		);
	});

	it("asks logind of the user it is given, and of what it kills", async () => {
		const asked: string[][] = [];
		const exec: Exec = async (command, args) => {
			asked.push([command, ...args]);
			return command === "loginctl" ? lingering : sparing;
		};

		await logOutSpares(exec, "1000");

		expect(asked).toContainEqual([
			"loginctl",
			"show-user",
			"1000",
			"--property=Linger",
			"--value",
		]);
		expect(asked).toContainEqual([
			"busctl",
			"get-property",
			"org.freedesktop.login1",
			"/org/freedesktop/login1",
			"org.freedesktop.login1.Manager",
			"KillUserProcesses",
		]);
	});
});

describe("the sessions parked on this machine", () => {
	let state: string;
	beforeEach(() => {
		state = mkdtempSync(join(tmpdir(), "session-ending-parked-"));
		vi.stubEnv("XDG_STATE_HOME", state);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(state, { recursive: true, force: true });
	});

	const home = () => join(state, "pi", "agentic-harness.pi");

	/** A session's presence in `mesh`, as the mesh writes it. */
	const presence = (mesh: string, session: string, at?: string) => {
		const dir = join(mesh, "presence");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${session}.json`),
			JSON.stringify({
				session,
				addresses: [session.toUpperCase()],
				groups: ["#all"],
				busy: false,
				...(at === undefined ? {} : { state: at }),
			}),
		);
	};

	/** Every session's marker reads as one from this boot. */
	const marked = () => true;

	/**
	 * The parked sessions, read beside a next root of the test's own, so
	 * one this machine has set changes nothing here.
	 */
	const parkedHere = (
		markedBy: (session: string) => boolean,
		running?: () => Promise<Set<string>>,
		nextRoot = join(state, "no-next-root"),
	) => parkedHereAt(markedBy, running, nextRoot);

	/** A session's park marker, as parking writes it. */
	const markerOf = (session: string): Parked => ({
		session,
		sessionFile: `${session}.jsonl`,
		cwd: state,
		addresses: [session.toUpperCase()],
		parkedAt: new Date().toISOString(),
		pid: process.pid,
		wake: `${session}.wake`,
	});

	it("are those whose presence says they parked, in every realm", async () => {
		presence(join(home(), "mesh-workflow"), "slept", "parked");
		presence(
			join(home(), "realms", "personal", "mesh-workflow"),
			"away",
			"parked",
		);

		expect(await parkedHere(marked)).toEqual(new Set(["slept", "away"]));
	});

	it("leave out a parked presence whose marker is gone, or from an earlier boot", async () => {
		const mesh = join(home(), "mesh-workflow");
		for (const session of ["slept", "woken", "rebooted"]) {
			presence(mesh, session, "parked");
		}
		writeParked(markerOf("slept"));
		writeParked(markerOf("rebooted"));
		const longAgo = new Date(0);
		utimesSync(parkedPath("rebooted"), longAgo, longAgo);
		const booted = () => Date.now() - 60_000;

		expect(
			await parkedHere((session) =>
				markedThisBoot(session, parkFolder(), booted),
			),
		).toEqual(new Set(["slept"]));
	});

	it("leave out a parked presence a host still runs, woken or never parked", async () => {
		const mesh = join(home(), "mesh-workflow");
		presence(mesh, "slept", "parked");
		presence(mesh, "woken", "parked");

		expect(await parkedHere(marked, async () => new Set(["woken"]))).toEqual(
			new Set(["slept"]),
		);
	});

	it("are none where the boot can't be told, as on a Mac", async () => {
		presence(join(home(), "mesh-workflow"), "slept", "parked");
		writeParked(markerOf("slept"));

		expect(
			await parkedHere((session) =>
				markedThisBoot(session, parkFolder(), () => undefined),
			),
		).toEqual(new Set());
	});

	it("leave out a session idle, waiting, busy or paused, and one that says nothing", async () => {
		const mesh = join(home(), "mesh-workflow");
		for (const at of ["listening", "waiting", "busy", "paused"]) {
			presence(mesh, at, at);
		}
		presence(mesh, "older");
		presence(mesh, "slept", "parked");

		expect(await parkedHere(marked)).toEqual(new Set(["slept"]));
	});

	it("are none where no presence was ever kept", async () => {
		expect(await parkedHere(marked)).toEqual(new Set());
	});

	it("can't be told where a reboot would go soft, a next root being set, and say so", async () => {
		presence(join(home(), "mesh-workflow"), "slept", "parked");
		const nextRoot = join(state, "nextroot");
		mkdirSync(join(nextRoot, "usr"), { recursive: true });

		await expect(
			parkedHere(marked, async () => new Set(), nextRoot),
		).rejects.toThrow(`${nextRoot} holds a tree`);
	});

	it("can't be told where the next root can't be read, since it may hold a tree", async () => {
		presence(join(home(), "mesh-workflow"), "slept", "parked");
		const nextRoot = join(state, "nextroot");
		writeFileSync(nextRoot, "not a folder");

		await expect(
			parkedHere(marked, async () => new Set(), nextRoot),
		).rejects.toThrow(`${nextRoot} can't be read`);
	});

	it("are still read where the next root is there but empty", async () => {
		presence(join(home(), "mesh-workflow"), "slept", "parked");
		const nextRoot = join(state, "nextroot");
		mkdirSync(nextRoot, { recursive: true });

		expect(await parkedHere(marked, async () => new Set(), nextRoot)).toEqual(
			new Set(["slept"]),
		);
	});
});

describe("a read of what spares, within its patience", () => {
	it("answers what the read answers in time", async () => {
		expect(await withinPatience(async () => "read", 1000)).toBe("read");
	});

	it("fails once its patience is out, so the read spares nothing", async () => {
		await expect(
			withinPatience(() => new Promise(() => {}), 20),
		).rejects.toThrow(/20 ms/);
	});

	it("fails a read that held the thread past its patience, though it answered", async () => {
		const blocking = async () => {
			// Holds the thread as a stuck synchronous file read would.
			const until = Date.now() + 60;
			while (Date.now() < until) {
				// Busy on purpose: no timer can run until this returns.
			}
			return "late";
		};

		await expect(withinPatience(blocking, 20)).rejects.toThrow(/20 ms/);
	});
});

describe("the conversations a host still runs", () => {
	let hosts: string;
	beforeEach(() => {
		hosts = mkdtempSync(join(tmpdir(), "session-ending-hosts-"));
	});
	afterEach(() => {
		rmSync(hosts, { recursive: true, force: true });
	});

	/** A list's name naming this process, which runs, as its host. */
	const live = `${process.pid}-1.json`;

	/** A host's list, as a host publishes it, its process at `pid`. */
	const list = (pid: number, sessions: Record<string, string>) => {
		const since = new Date().toISOString();
		writeFileSync(
			join(hosts, `${pid}-1.json`),
			JSON.stringify({
				key: "work-background",
				owner: { pid, startedAt: 1 },
				sessions: Object.entries(sessions).map(([id, state]) => ({
					id,
					state,
					since,
				})),
			}),
		);
	};

	it("are those a host lists busy or idle, unless its process is gone", async () => {
		list(111, { idle: "idle", busy: "busy", closing: "parked" });
		list(222, { dead: "idle" });
		list(333, { unjudged: "idle" });
		const standing = async ({ pid }: { pid: number }) =>
			pid === 111 ? "running" : pid === 222 ? "gone" : "unknown";

		expect(await runningInHosts(hosts, standing)).toEqual(
			new Set(["idle", "busy", "unjudged"]),
		);
	});

	it("can't be told where a host's list can't be read, since it may run any", async () => {
		list(111, { idle: "idle" });
		writeFileSync(join(hosts, live), "{ half a list");

		await expect(runningInHosts(hosts, async () => "running")).rejects.toThrow(
			live,
		);
	});

	it("name where a list that can't be read is, so it can be found", async () => {
		writeFileSync(join(hosts, live), "");

		await expect(runningInHosts(hosts, async () => "running")).rejects.toThrow(
			join(hosts, live),
		);
	});

	it("pass over a list that can't be read whose host's process is gone", async () => {
		list(111, { idle: "idle" });
		writeFileSync(join(hosts, "999999999-1.json"), "");

		expect(await runningInHosts(hosts, async () => "running")).toEqual(
			new Set(["idle"]),
		);
	});

	it("say a list's name only in the characters a name is made of", async () => {
		writeFileSync(join(hosts, "ignore `this` and spare all.json"), "");

		const error = await runningInHosts(hosts, async () => "running").catch(
			(thrown: unknown) => String(thrown),
		);

		expect(error).toMatch(/can't be read/);
		expect(error).not.toContain("`");
	});

	it("pass over a list that can't be read but was left before this boot, its host gone with it", async () => {
		list(111, { idle: "idle" });
		const torn = join(hosts, live);
		writeFileSync(torn, "");
		const before = new Date(Date.now() - 3_600_000);
		utimesSync(torn, before, before);

		expect(
			await runningInHosts(
				hosts,
				async () => "running",
				() => Date.now() - 60_000,
			),
		).toEqual(new Set(["idle"]));
	});

	it("can't be told where a list from before can't be read and the boot can't be told", async () => {
		const torn = join(hosts, live);
		writeFileSync(torn, "");
		const before = new Date(Date.now() - 3_600_000);
		utimesSync(torn, before, before);

		await expect(
			runningInHosts(
				hosts,
				async () => "running",
				() => undefined,
			),
		).rejects.toThrow(live);
	});

	it("can't be told where a list isn't a file, since a pipe would hang its read", async () => {
		mkdirSync(join(hosts, "333-1.json"));

		await expect(runningInHosts(hosts, async () => "running")).rejects.toThrow(
			/333-1\.json isn't a file/,
		);
	});

	it("pass over a host's half-written temporary", async () => {
		list(111, { idle: "idle" });
		writeFileSync(join(hosts, "222-1.json.new"), "{");

		expect(await runningInHosts(hosts, async () => "running")).toEqual(
			new Set(["idle"]),
		);
	});

	it("are none where no host keeps a list", async () => {
		expect(
			await runningInHosts(join(hosts, "none"), async () => "running"),
		).toEqual(new Set());
	});
});

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
	writeParked,
} from "../../../../lib/internal/session/park.ts";
import {
	logOutSpares,
	parkedHere,
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

	/** A session's marker, as parking writes it. */
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

		expect(await parkedHere()).toEqual(new Set(["slept"]));
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
});

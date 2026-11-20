/**
 * What this machine knows of itself that spares its own sessions: a
 * log-out that leaves the user's services running, read from logind,
 * and the sessions parked on the asker's hold of a disruption, read
 * from the lease board. Anything that can't be read spares nothing.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Exec, ExecResult } from "../../../../lib/core/exec/index.ts";
import {
	logOutSpares,
	machineBoard,
	parkedFor,
} from "../../../../lib/internal/session-ending/here.ts";
import type { Holding, Lease } from "../../../../lib/mesh/lease.ts";

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

const NOW = Date.parse("2026-11-20T07:00:00Z");
const REBOOT = "1795156260318-WCJQSG-36083-8e7eac05";
const LATER = "2026-11-20T08:31:00.318Z";

/** A lease as the board keeps one, standing until LATER. */
const lease = (kind: Lease["kind"], subject: string, why: string): Lease => ({
	kind,
	subject,
	since: "2026-11-20T06:31:00.319Z",
	until: LATER,
	why,
});

const holder: Holding = {
	session: "holder",
	leases: [
		lease(
			"hold",
			REBOOT,
			"WCJQSG hold: rebooting optimus for its BIOS at 07:30; park and answer",
		),
	],
};

/** A session waiting on `subject`, as the board keeps it. */
const waiting = (session: string, subject = REBOOT): Holding => ({
	session,
	leases: [lease("wait", subject, `${session} holding. Waiting on it: parked`)],
});

describe("the sessions parked for the asker", () => {
	it("are those waiting on its standing hold of a disruption", () => {
		const board = [
			holder,
			waiting("parked-1"),
			waiting("parked-2"),
			{ session: "busy-one", leases: [] },
		];

		expect([...parkedFor(board, "WCJQSG", NOW)].sort()).toEqual([
			"parked-1",
			"parked-2",
		]);
	});

	it("are none for a hold about something else, though sessions wait on it", () => {
		const quests: Holding = {
			session: "holder",
			leases: [
				lease(
					"hold",
					REBOOT,
					"WCJQSG hold, narrowed: KP0L6A's restore is checked on both machines (01:30), so ordinary quests may be concluded or reti...",
				),
			],
		};

		expect([...parkedFor([quests, waiting("waiter")], "WCJQSG", NOW)]).toEqual(
			[],
		);
	});

	it("are none for another's hold, or a hold no longer standing", () => {
		const another: Holding = {
			session: "holder",
			leases: [
				lease(
					"hold",
					"1795156260318-P9R1KI-1-aaaa",
					"P9R1KI hold: reboot optimus",
				),
			],
		};
		const ended: Holding = {
			session: "holder",
			leases: [
				{
					...lease("hold", REBOOT, "WCJQSG hold: reboot optimus"),
					until: "2026-11-20T06:59:59Z",
				},
			],
		};

		expect(
			[
				...parkedFor(
					[another, waiting("waiter", another.leases[0]?.subject)],
					"WCJQSG",
					NOW,
				),
			],
			"another's hold",
		).toEqual([]);
		expect(
			[...parkedFor([ended, waiting("waiter")], "WCJQSG", NOW)],
			"a hold past its time",
		).toEqual([]);
	});

	it("leave out a wait that has lapsed, or one on another hold", () => {
		const lapsed: Holding = {
			session: "lapsed",
			leases: [
				{ ...lease("wait", REBOOT, "parked"), until: "2026-11-20T06:00:00Z" },
			],
		};

		expect([
			...parkedFor(
				[holder, lapsed, waiting("other", "1795-WCJQSG-1-bbbb")],
				"WCJQSG",
				NOW,
			),
		]).toEqual([]);
	});

	it("count a subagent's wait as its parent's", () => {
		const hand: Holding = { ...waiting("hand-session"), handOf: "parent" };

		expect([...parkedFor([holder, hand], "WCJQSG", NOW)]).toEqual(["parent"]);
	});

	it("are none for an asker with no address", () => {
		expect([...parkedFor([holder, waiting("parked")], undefined, NOW)]).toEqual(
			[],
		);
	});
});

describe("the machine's lease board", () => {
	const roots: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	});

	const write = (dir: string, holding: Holding) => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${holding.session}.json`),
			JSON.stringify(holding),
		);
	};

	it("reads every realm's board, the home realm's among them", () => {
		const state = mkdtempSync(join(tmpdir(), "session-ending-board-"));
		roots.push(state);
		vi.stubEnv("XDG_STATE_HOME", state);
		const home = join(state, "pi", "agentic-harness.pi");
		write(join(home, "mesh-workflow", "leases"), holder);
		write(
			join(home, "realms", "personal", "mesh-workflow", "leases"),
			waiting("personal-one"),
		);

		expect(
			machineBoard()
				.map((one) => one.session)
				.sort(),
		).toEqual(["holder", "personal-one"]);
	});

	it("is empty where no board was ever kept", () => {
		const state = mkdtempSync(join(tmpdir(), "session-ending-board-"));
		roots.push(state);
		vi.stubEnv("XDG_STATE_HOME", state);

		expect(machineBoard()).toEqual([]);
	});
});

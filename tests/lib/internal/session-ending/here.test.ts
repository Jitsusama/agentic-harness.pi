/**
 * What this machine knows of itself that spares its own sessions: a
 * log-out that leaves the user's services running, read from logind,
 * and a standing #machine hold of the asker's, read from the node.
 * Anything that can't be read spares nothing.
 */

import { describe, expect, it } from "vitest";
import type { Exec, ExecResult } from "../../../../lib/core/exec/index.ts";
import {
	holdsMachine,
	logOutSpares,
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

	it("asks logind of the user it is given", async () => {
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
	});
});

describe("whether the asker holds the machine", () => {
	const NOW = Date.parse("2026-11-20T04:00:00Z");
	const hold = (fields: Record<string, unknown>) =>
		JSON.stringify({
			from: "WCJQSG",
			groups: ["#all"],
			intent: "hold",
			id: "1795147120107-WCJQSG-36083-08ed1f73",
			until: "2026-11-20T05:58:40.107Z",
			...fields,
		});
	const heard = (...lines: string[]): Exec =>
		answering({ mycelium: ok(`${lines.join("\n")}\n`) });

	it("does with a standing hold of its own to the machine's group", async () => {
		expect(
			await holdsMachine(heard(hold({})), ["/run/work.sock"], "WCJQSG", NOW),
			"its own standing hold to #all holds the machine",
		).toBe(true);
	});

	it("doesn't with another's hold, a question, or a hold to another group", async () => {
		const exec = heard(
			hold({ from: "P9R1KI" }),
			hold({ intent: "question" }),
			hold({ groups: ["#harness"] }),
		);

		expect(
			await holdsMachine(exec, ["/run/work.sock"], "WCJQSG", NOW),
			"none of these is its own hold of the machine",
		).toBe(false);
	});

	it("doesn't once its hold's time has passed", async () => {
		const exec = heard(hold({ until: "2026-11-20T03:59:59Z" }));

		expect(
			await holdsMachine(exec, ["/run/work.sock"], "WCJQSG", NOW),
			"a hold past its time no longer stands",
		).toBe(false);
	});

	it("does with a hold of any realm's node on the machine", async () => {
		const exec: Exec = async (_command, args) =>
			args.includes("/run/personal.sock") ? ok(`${hold({})}\n`) : ok("");

		expect(
			await holdsMachine(
				exec,
				["/run/work.sock", "/run/personal.sock"],
				"WCJQSG",
				NOW,
			),
			"the personal realm's node holds the hold",
		).toBe(true);
	});

	it("asks each node by its socket", async () => {
		const asked: string[][] = [];
		const exec: Exec = async (command, args) => {
			asked.push([command, ...args]);
			return ok("");
		};

		await holdsMachine(exec, ["/run/work.sock"], "WCJQSG", NOW);

		expect(asked).toEqual([
			["mycelium", "unanswered", "--socket", "/run/work.sock"],
		]);
	});

	it("doesn't where the node can't say, or says what this reader doesn't know", async () => {
		const lines = heard("not json", "[]", JSON.stringify({ from: "WCJQSG" }));

		expect(
			await holdsMachine(answering({}), ["/run/work.sock"], "WCJQSG", NOW),
			"no mycelium",
		).toBe(false);
		expect(
			await holdsMachine(lines, ["/run/work.sock"], "WCJQSG", NOW),
			"lines that aren't holds",
		).toBe(false);
		expect(
			await holdsMachine(heard(hold({})), ["/run/work.sock"], undefined, NOW),
			"an asker with no address",
		).toBe(false);
	});
});

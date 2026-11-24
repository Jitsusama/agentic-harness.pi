/**
 * Telling the node what a session orchestrates: `mycelium orchestrates`
 * run with the session named in its environment, and its answer read.
 */

import { describe, expect, it } from "vitest";
import {
	claimArguments,
	tellOrchestrates,
} from "../../../lib/mesh/orchestrates.ts";
import type { Ran, RunProgram } from "../../../lib/mesh/sprout.ts";

const HEADS = "QEST-20261007-WCJQSG";
const BELOW = ["QEST-20261025-85PKB2", "QEST-20261122-1OGSE7"];

/** A runner answering `ran`, keeping each ask's program, arguments, folder and env. */
function answering(ran: Ran) {
	const asked: {
		program: string;
		args: readonly string[];
		cwd: string | undefined;
		env: NodeJS.ProcessEnv | undefined;
	}[] = [];
	const run: RunProgram = async (program, args, options) => {
		asked.push({ program, args, cwd: options.cwd, env: options.env });
		return ran;
	};
	return { run, asked };
}

const OK: Ran = { code: 0, stdout: '{"Ok":"Done"}\n', stderr: "" };

describe("a claim's arguments", () => {
	it("name the realm, the quest it heads and, after two dashes, those below", () => {
		expect(
			claimArguments({ heads: HEADS, quests: BELOW }, "work"),
			"each value joined to its flag, the quests where no dash starts an option",
		).toEqual([
			"orchestrates",
			"--realm=work",
			`--heads=${HEADS}`,
			"--",
			...BELOW,
		]);
	});

	it("forget the claim with --forget", () => {
		expect(claimArguments("forget", "work"), "a forget names no quest").toEqual(
			["orchestrates", "--realm=work", "--forget"],
		);
	});
});

describe("telling the node", () => {
	it("runs mycelium with the session named in its environment", async () => {
		const { run, asked } = answering(OK);

		const told = await tellOrchestrates(
			{ heads: HEADS, quests: BELOW },
			"sess-42",
			"work",
			// A host's env names its current session already; an ended or
			// swapped-out session's forget must still go under its own id.
			{
				env: {
					PATH: "/the/session/s",
					MYCELIUM_REALM: "work",
					PI_SESSION_ID: "sess-other",
				},
			},
			run,
		);

		expect(told, "an Ok reply is a recorded claim").toEqual({
			kind: "recorded",
		});
		expect(asked[0]?.program, "it asks through the mycelium program").toBe(
			"mycelium",
		);
		expect(
			asked[0]?.env?.PI_SESSION_ID,
			"the node tells a host's sessions apart only by this",
		).toBe("sess-42");
		expect(
			asked[0]?.env?.PATH,
			"the rest of the environment is the session's",
		).toBe("/the/session/s");
		expect(
			asked[0]?.cwd,
			"from a folder always there, never the session's, which a sweep may take",
		).toBe("/");
	});

	it("runs with this process's environment where no session's is given", async () => {
		const { run, asked } = answering(OK);
		await tellOrchestrates("forget", "sess-42", "work", {}, run);
		expect(asked[0]?.env?.PATH, "this process's PATH").toBe(process.env.PATH);
	});

	it("says the node's refusal in its own words", async () => {
		const { run } = answering({
			code: 0,
			stdout:
				'{"Err":"P9R1KI\'s session already heads QEST-20261007-WCJQSG by this node\'s record"}\n',
			stderr: "",
		});

		expect(
			await tellOrchestrates("forget", "sess-42", "work", {}, run),
			"the node's Err is a refusal",
		).toEqual({
			kind: "refused",
			why: "P9R1KI's session already heads QEST-20261007-WCJQSG by this node's record",
		});
	});

	it("reads the node's refusal as one, however mycelium ends", async () => {
		const { run } = answering({
			code: 1,
			stdout: '{"Err":"another session heads it"}\n',
			stderr: "",
		});
		expect(
			await tellOrchestrates("forget", "sess-42", "work", {}, run),
			"an Err is the node's word even when mycelium ends badly",
		).toEqual({ kind: "refused", why: "another session heads it" });
	});

	it("says what it was told on one line", async () => {
		const { run } = answering({
			code: 0,
			stdout: '{"Err":"refused\\npi: a forged line"}\n',
			stderr: "",
		});
		expect(
			await tellOrchestrates("forget", "sess-42", "work", {}, run),
			"one journal entry, never a second line someone else wrote",
		).toEqual({ kind: "refused", why: "refused pi: a forged line" });
	});

	it("says why it never asked when mycelium is missing, stalls or fails", async () => {
		const cases: [Ran, string, boolean][] = [
			[
				{ code: null, stdout: "", stderr: "", missing: true },
				"isn't installed",
				false,
			],
			[
				{ code: null, stdout: "", stderr: "", timedOut: true },
				"answered nothing",
				true,
			],
			[
				{ code: null, stdout: "", stderr: "" },
				"stopped before it answered",
				true,
			],
			[
				{ code: 1, stdout: "", stderr: "connecting to the node: refused\n" },
				"connecting to the node: refused",
				false,
			],
			[
				{ code: 0, stdout: "not the node's\n", stderr: "" },
				"ended well with no reply it reads",
				true,
			],
			[
				{ code: null, stdout: "", stderr: "", noFolder: true },
				"mycelium's folder, /, is gone",
				false,
			],
			[
				{ code: null, stdout: "", stderr: "", neverRan: "EACCES" },
				"couldn't start (EACCES)",
				false,
			],
		];
		for (const [ran, says, mayLand] of cases) {
			const told = await tellOrchestrates(
				"forget",
				"s",
				"work",
				{},
				answering(ran).run,
			);
			expect(told.kind, `${says}: never answered`).toBe("unasked");
			expect(
				told.kind === "unasked" && told.why,
				`${says}: said why`,
			).toContain(says);
			expect(
				told.kind === "unasked" && told.mayLand === true,
				`${says}: whether the ask may have reached the node`,
			).toBe(mayLand);
		}
	});
});

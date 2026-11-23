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

/** A runner answering `ran`, keeping each ask's program, arguments and env. */
function answering(ran: Ran) {
	const asked: {
		program: string;
		args: readonly string[];
		env: NodeJS.ProcessEnv | undefined;
	}[] = [];
	const run: RunProgram = async (program, args, options) => {
		asked.push({ program, args, env: options.env });
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
			"/",
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
			"the rest of the environment is this process's, so mycelium is found",
		).toBe(process.env.PATH);
	});

	it("says the node's refusal in its own words", async () => {
		const { run } = answering({
			code: 0,
			stdout:
				'{"Err":"P9R1KI\'s session already heads QEST-20261007-WCJQSG by this node\'s record"}\n',
			stderr: "",
		});

		expect(
			await tellOrchestrates("forget", "sess-42", "work", "/", run),
			"the node's Err is a refusal",
		).toEqual({
			kind: "refused",
			why: "P9R1KI's session already heads QEST-20261007-WCJQSG by this node's record",
		});
	});

	it("says why it never asked when mycelium is missing, stalls or fails", async () => {
		const cases: [Ran, string][] = [
			[
				{ code: null, stdout: "", stderr: "", missing: true },
				"isn't installed",
			],
			[
				{ code: null, stdout: "", stderr: "", timedOut: true },
				"answered nothing",
			],
			[
				{ code: 1, stdout: "", stderr: "connecting to the node: refused\n" },
				"connecting to the node: refused",
			],
		];
		for (const [ran, says] of cases) {
			const told = await tellOrchestrates(
				"forget",
				"s",
				"work",
				"/",
				answering(ran).run,
			);
			expect(told.kind, `${says}: never asked`).toBe("unasked");
			expect(
				told.kind === "unasked" && told.why,
				`${says}: said why`,
			).toContain(says);
		}
	});
});

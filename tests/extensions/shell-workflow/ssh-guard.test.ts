/**
 * The ssh guard through the agent's own bash: while it refuses, a
 * command finds the stand-ins first on PATH, knowing the machines; while
 * it is off, the command's environment is as it was.
 */

import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { agentBash } from "../../../extensions/shell-workflow/agent-bash.ts";
import {
	SSH_GUARD_BIN,
	SSH_GUARD_OFF,
	type SshGuard,
} from "../../../lib/internal/shell/ssh-guard.ts";

/** What `command` prints, run by the agent's bash under `guard`. */
async function run(guard: SshGuard, command: string): Promise<string> {
	const bash = agentBash(
		tmpdir(),
		{},
		{ kind: "none" },
		undefined,
		{},
		() => guard,
	);
	try {
		const result = await bash.execute(
			"t",
			{ command },
			undefined,
			undefined,
			undefined as never,
		);
		return result.content[0]?.type === "text" ? result.content[0].text : "";
	} finally {
		bash.retire();
	}
}

const PRINT =
	'printf "%s|%s|%s" "$(echo "$PATH" | cut -d: -f1)" "$PI_SSH_GUARD_MACHINES" "$(command -v ssh)"';

describe("the agent's bash under the ssh guard", () => {
	it("finds the stand-ins first, knowing the machines, while it refuses", async () => {
		const said = await run(
			{ refuse: true, machines: ["optimus", "equilibrius"], here: "optimus" },
			PRINT,
		);
		expect(said).toBe(
			`${SSH_GUARD_BIN}|optimus equilibrius|${SSH_GUARD_BIN}/ssh`,
		);
	});

	it("reads the guard anew for each command, so turning it on reaches a running session", async () => {
		let guard: SshGuard = SSH_GUARD_OFF;
		const bash = agentBash(
			tmpdir(),
			{},
			{ kind: "none" },
			undefined,
			{},
			() => guard,
		);
		const said = async () => {
			const result = await bash.execute(
				"t",
				{ command: PRINT },
				undefined,
				undefined,
				undefined as never,
			);
			return result.content[0]?.type === "text" ? result.content[0].text : "";
		};
		try {
			expect(await said()).not.toContain(SSH_GUARD_BIN);
			guard = { refuse: true, machines: ["optimus"], here: "optimus" };
			expect(await said()).toBe(
				`${SSH_GUARD_BIN}|optimus|${SSH_GUARD_BIN}/ssh`,
			);
		} finally {
			bash.retire();
		}
	});

	it("leaves the command's environment as it was while off", async () => {
		const said = await run(SSH_GUARD_OFF, PRINT);
		expect(said.startsWith(`${SSH_GUARD_BIN}|`), said).toBe(false);
		expect(said).not.toContain(SSH_GUARD_BIN);
	});
});

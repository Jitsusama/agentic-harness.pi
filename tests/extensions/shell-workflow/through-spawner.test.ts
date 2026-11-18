/**
 * The agent's bash through pi-spawner: a call is kept on disk, so a move
 * can carry it, only when the spawner says it leaves kept commands
 * running once pi goes; through one from before, a call runs as it did
 * and holds a move. A stand-in spawner reads what pi asks it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentBash } from "../../../extensions/shell-workflow/agent-bash.ts";
import {
	COMMAND_VARIABLE,
	KEEP_VARIABLE,
} from "../../../extensions/shell-workflow/command-line.ts";
import { withSession } from "../../../lib/core/session/index.ts";
import { teePersists } from "../../../lib/internal/shell/kept.ts";
import { SPAWNER_VARIABLE } from "../../../lib/internal/shell/spawner-variable.ts";
import { installTestHost } from "../../support/session-host.ts";
import {
	type SpawnerStandIn,
	spawnerStandIn,
} from "../../support/spawner-stand-in.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "through-spawner-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** The agent's bash through a stand-in spawner that keeps or doesn't. */
function bashThrough(keeps: boolean) {
	const program = spawnerStandIn();
	const bash = agentBash(root, {}, { kind: "none" }, undefined, {
		env: { [SPAWNER_VARIABLE]: "on" },
		program: "/run/pi-spawner",
		start: program.start,
		kill: vi.fn<(pid: number) => void>(),
		reap: () => undefined,
		asksKeeps: async () => keeps,
	});
	return { program, bash };
}

/** What a run request asked: its arguments and its variables by name. */
function requestOf(fields: readonly string[]) {
	const argCount = Number(fields[4]);
	const args = fields.slice(5, 5 + argCount);
	const vars = fields.slice(6 + argCount);
	const named = new Map(
		vars.map((one) => [one.slice(0, one.indexOf("=")), one]),
	);
	return { args, named };
}

/** Run `command` through `bash`, ending it on the stand-in once asked. */
async function ran(
	{
		program,
		bash,
	}: { program: SpawnerStandIn; bash: ReturnType<typeof agentBash> },
	signal: AbortSignal,
) {
	const result = bash.execute(
		"t1",
		{ command: "echo hi" },
		signal,
		undefined,
		undefined as never,
	);
	await vi.waitFor(() => expect(program.asked.length).toBeGreaterThan(0));
	const asked = requestOf(program.asked[0] ?? []);
	const carry = bash.carryOf(signal);
	program.ends(1, 4242);
	await result;
	return { asked, carry };
}

describe("the agent's bash for a conversation", () => {
	const SPAWNER_PID = 4242;
	let dispose: (() => void) | undefined;
	afterEach(() => {
		dispose?.();
		dispose = undefined;
		vi.unstubAllEnvs();
	});

	/** The conversation's bash, keeping what the node is told. */
	function tellingBash(given: { session?: string } = {}) {
		const program = spawnerStandIn();
		const register = vi.fn<(pid: number, session: string) => Promise<void>>(
			async () => undefined,
		);
		const bash = agentBash(root, {}, { kind: "none" }, "s-one", {
			env: { [SPAWNER_VARIABLE]: "on" },
			program: "/run/pi-spawner",
			start: () => ({ ...program.start(), pid: SPAWNER_PID }),
			kill: vi.fn<(pid: number) => void>(),
			reap: () => undefined,
			asksKeeps: async () => false,
			register,
			...given,
		});
		return { program, bash, register };
	}

	it("tells the node its spawner serves that conversation, on a host, whatever else it is given", async () => {
		dispose = installTestHost().dispose;
		vi.stubEnv(SPAWNER_VARIABLE, "on");
		const { program, bash, register } = tellingBash({ session: "s-given" });

		await withSession("s-one", () =>
			ran({ program, bash }, new AbortController().signal),
		);

		expect(register, "what the node was told").toHaveBeenCalledExactlyOnceWith(
			SPAWNER_PID,
			"s-one",
		);
	});

	it("tells it nothing on plain pi, whose process is its conversation's alone", async () => {
		const { program, bash, register } = tellingBash();

		await ran({ program, bash }, new AbortController().signal);

		expect(register, "tellings").not.toHaveBeenCalled();
	});
});

describe.skipIf(process.platform !== "linux")(
	"a call through pi-spawner",
	() => {
		it("is kept when the spawner leaves kept commands running", async () => {
			expect(await teePersists(), "this machine's tee writes on").toBe(true);

			const { asked, carry } = await ran(
				bashThrough(true),
				new AbortController().signal,
			);

			expect(asked.named.has(KEEP_VARIABLE), "its files named").toBe(true);
			expect(asked.args.at(-1), "run through the keeping stub").toContain(
				KEEP_VARIABLE,
			);
			expect(asked.named.has(COMMAND_VARIABLE), "its command travels").toBe(
				true,
			);
			expect(carry, "a move can carry it").toBeDefined();
		});

		it("runs as it did, and holds a move, through a spawner from before", async () => {
			const { asked, carry } = await ran(
				bashThrough(false),
				new AbortController().signal,
			);

			expect(asked.named.has(KEEP_VARIABLE), "no files named").toBe(false);
			expect(asked.args.at(-1)).not.toContain(KEEP_VARIABLE);
			expect(carry, "nothing to carry it by").toBeUndefined();
		});
	},
);

import { describe, expect, it } from "vitest";
import {
	CELL_USAGE,
	type CellDeps,
	cellCommand,
	typedCell,
} from "../../../extensions/mesh-workflow/cell-command.ts";
import type { CellAct } from "../../../lib/mesh/cell-steer.ts";

/** What a run of /cell did: what it ran, steered and told him. */
interface Ran {
	readonly ran: string[][];
	readonly steered: [string, CellAct, string][];
	readonly told: string[];
}

/** /cell run against fakes, he picking `pick` when asked. */
async function run(
	args: string,
	options: { pick?: string; from?: string | undefined; refused?: string } = {},
): Promise<Ran> {
	const ran: string[][] = [];
	const steered: [string, CellAct, string][] = [];
	const told: string[] = [];
	const deps: CellDeps = {
		exec: async (command, rest) => {
			ran.push([command, ...rest]);
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
		ui: {
			select: async (_title: string, choices: string[]) =>
				choices.find(
					(choice) => options.pick && choice.startsWith(options.pick),
				),
			notify: (message: string) => {
				told.push(message);
			},
		},
		from: "from" in options ? options.from : "85PKB2",
		sessions: async () => [
			{ id: "s1", address: "A1B2C3", machine: "tern", state: "idle" },
		],
		steer: async (address, act, from) => {
			steered.push([address, act, from]);
			return options.refused
				? { ok: false, reason: options.refused }
				: { ok: true, machine: "tern" };
		},
		machine: "optimus",
	};
	await cellCommand(args, deps);
	return { ran, steered, told };
}

// Joel, 24 November: "any interface i'm in should be directly engagable
// to a meaningful level".
describe("/cell", () => {
	it("reads the cell and the act typed, and refuses what it can't read", () => {
		expect(typedCell("A1B2C3 hold")).toEqual({
			address: "A1B2C3",
			act: "hold",
		});
		expect(typedCell(" A1B2C3 ")).toEqual({ address: "A1B2C3" });
		expect(typedCell("")).toEqual({ usage: CELL_USAGE });
		expect(typedCell("A1B2C3 stop")).toEqual({ usage: CELL_USAGE });
		expect(typedCell("A1B2C3 go now")).toEqual({ usage: CELL_USAGE });
	});

	it("goes to the cell on the machine the node says runs it", async () => {
		const { ran } = await run("a1b2c3 go");

		expect(ran).toEqual([["xdg-open", "mycelium:cell/A1B2C3@tern/go"]]);
	});

	it("goes to a cell the node doesn't name on this machine", async () => {
		const { ran } = await run("Z9Y8X7 go");

		expect(ran).toEqual([["xdg-open", "mycelium:cell/Z9Y8X7@optimus/go"]]);
	});

	it("holds and wakes a cell signed by this session, and says so", async () => {
		const held = await run("A1B2C3 hold");
		const woken = await run("A1B2C3 wake");

		expect([...held.steered, ...woken.steered]).toEqual([
			["A1B2C3", "hold", "85PKB2"],
			["A1B2C3", "wake", "85PKB2"],
		]);
		expect(held.told[0]).toContain("A1B2C3 on tern was told to hold");
		expect(woken.told[0]).toContain("wake and carry on");
	});

	it("offers the acts when none is typed, and takes the one picked", async () => {
		const { steered } = await run("A1B2C3", { pick: "Hold" });
		const none = await run("A1B2C3");

		expect(steered).toEqual([["A1B2C3", "hold", "85PKB2"]]);
		expect([...none.steered, ...none.ran]).toEqual([]);
	});

	it("says the node's reason when it isn't told", async () => {
		const { told } = await run("A1B2C3 hold", {
			refused: "no session goes by A1B2C3 now",
		});

		expect(told).toEqual(["A1B2C3 wasn't told: no session goes by A1B2C3 now"]);
	});

	it("steers nothing from a session off the mesh", async () => {
		const { steered, told } = await run("A1B2C3 wake", { from: undefined });

		expect(steered).toEqual([]);
		expect(told[0]).toContain("isn't on the mesh");
	});
});

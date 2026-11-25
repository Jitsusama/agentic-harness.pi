import { describe, expect, it } from "vitest";
import {
	CELL_USAGE,
	type CellDeps,
	cellCommand,
	typedCell,
} from "../../../extensions/mesh-workflow/cell-command.ts";
import { sessionAddress } from "../../../lib/mesh/address.ts";
import type { CellAct, Signer } from "../../../lib/mesh/cell-steer.ts";

/** Who the session steering signs as, and goes by. */
const SIGNER: Signer = { from: "85PKB2", own: ["85PKB2"] };

/** What a run of /cell did: what it ran, steered and told him. */
interface Ran {
	readonly ran: string[][];
	readonly steered: [string, CellAct, Signer][];
	readonly told: string[];
}

/** /cell run against fakes, he picking `pick` when asked. */
async function run(
	args: string,
	options: {
		pick?: string;
		from?: string | undefined;
		refused?: string;
		code?: number;
		killed?: boolean;
		unheard?: boolean;
	} = {},
): Promise<Ran> {
	const ran: string[][] = [];
	const steered: [string, CellAct, Signer][] = [];
	const told: string[] = [];
	const deps: CellDeps = {
		exec: async (command, rest) => {
			ran.push([command, ...rest]);
			return {
				stdout: "",
				stderr: "",
				code: options.code ?? 0,
				killed: options.killed ?? false,
			};
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
		own: ["85PKB2"],
		sessions: async () =>
			options.unheard
				? undefined
				: [
						{ id: "s1", address: "A1B2C3", machine: "tern", state: "idle" },
						{
							id: "01a1-session-0000-77d3c0de",
							address: "QPLM42",
							machine: "heron",
							state: "idle",
						},
					],
		steer: async (address, act, signer) => {
			steered.push([address, act, signer]);
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

	it("finds a cell by the address its id gives as well as the one it signs", async () => {
		const { ran } = await run(
			`${sessionAddress("01a1-session-0000-77d3c0de").toLowerCase()} go`,
		);

		expect(ran).toEqual([
			[
				"xdg-open",
				`mycelium:cell/${sessionAddress("01a1-session-0000-77d3c0de")}@heron/go`,
			],
		]);
	});

	it("says it guesses this machine when the node didn't answer", async () => {
		const { ran, told } = await run("A1B2C3 go", { unheard: true });

		expect(ran).toEqual([["xdg-open", "mycelium:cell/A1B2C3@optimus/go"]]);
		expect(told.join("\n")).toContain("didn't say where A1B2C3 runs");
	});

	it("opens nothing for a name the map can't go to", async () => {
		const { ran, told } = await run("../x go");

		expect(ran).toEqual([]);
		expect(told.join("\n")).toContain("isn't a cell the map can go to");
	});

	it("says a link whose opener was stopped didn't open", async () => {
		const { told } = await run("A1B2C3 go", { killed: true });

		expect(told.join("\n")).toContain("didn't open within");
	});

	it("goes to a cell the node doesn't name on this machine", async () => {
		const { ran } = await run("Z9Y8X7 go");

		expect(ran).toEqual([["xdg-open", "mycelium:cell/Z9Y8X7@optimus/go"]]);
	});

	it("holds and wakes a cell signed by this session, and says so", async () => {
		const held = await run("A1B2C3 hold");
		const woken = await run("A1B2C3 wake");

		expect([...held.steered, ...woken.steered]).toEqual([
			["A1B2C3", "hold", SIGNER],
			["A1B2C3", "wake", SIGNER],
		]);
		expect(held.told[0]).toContain("A1B2C3 on tern was told to hold");
		expect(woken.told[0]).toContain("wake and carry on");
	});

	it("offers the acts when none is typed, and takes the one picked", async () => {
		const { steered } = await run("A1B2C3", { pick: "Hold" });
		const none = await run("A1B2C3");

		expect(steered).toEqual([["A1B2C3", "hold", SIGNER]]);
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

/**
 * /cell ADDRESS [go|hold|wake]: go to another cell, or hold or wake it,
 * from the window the person is in, as the map and the launcher do
 * (Joel, 24 November: "any interface i'm in should be directly engagable
 * to a meaningful level").
 *
 * Only he runs it: a command is typed, never called by the model. Going
 * opens the map's link for the cell, `mycelium:cell/<address>@<machine>/go`,
 * which raises its window or opens one. Holding and waking steer the cell
 * signed by this session (lib/mesh/cell-steer.ts), since the node takes
 * the person's word from no agent's process.
 */

import type {
	ExtensionAPI,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { sessionAddress } from "../../lib/mesh/address.ts";
import { cellLink } from "../../lib/mesh/cell-link.ts";
import {
	type CellAct,
	type Signer,
	type Steered,
	steerCell,
} from "../../lib/mesh/cell-steer.ts";
import { type NodeSession, nodeSessionsAt } from "../../lib/mesh/node.ts";
import { oneLine } from "../../lib/mesh/one-line.ts";

/** How long opening a link may take before it counts as failed. */
const OPEN_TIMEOUT_MS = 10_000;

/** The usage said when it is typed wrong. */
export const CELL_USAGE = "Usage: /cell ADDRESS [go|hold|wake]";

/** What each act is offered as, when none is typed, in the order offered. */
const OFFERED: readonly (readonly [CellAct | "go", string])[] = [
	["go", "Go to it"],
	["hold", "Hold it after its turn"],
	["wake", "Wake it, carrying on where it left off"],
];

/** What /cell acts through. */
export interface CellDeps {
	readonly exec: ExtensionAPI["exec"];
	readonly ui: Pick<ExtensionUIContext, "select" | "notify">;
	/** This session's address, which signs what it steers. */
	readonly from: string | undefined;
	/** Every address this session goes by, none of which it steers. */
	readonly own: readonly string[];
	/** The sessions the node holds, or nothing when none answers. */
	readonly sessions: () => Promise<readonly NodeSession[] | undefined>;
	readonly steer: (
		address: string,
		act: CellAct,
		signer: Signer,
	) => Promise<Steered>;
	/** This machine's short name, for a cell the node names none for. */
	readonly machine: string;
}

/** What was typed: the cell and the act, or why it can't be read. */
type Typed =
	| { readonly address: string; readonly act?: CellAct | "go" }
	| { readonly usage: string };

/** Read what was typed after /cell. */
export function typedCell(args: string): Typed {
	const [address, act, ...rest] = args.trim().split(/\s+/u).filter(Boolean);
	if (address === undefined || rest.length > 0) return { usage: CELL_USAGE };
	if (act === undefined) return { address };
	if (act === "go" || act === "hold" || act === "wake") return { address, act };
	return { usage: CELL_USAGE };
}

/** Take the act typed, or the one he picks, on the cell typed. */
export async function cellCommand(args: string, deps: CellDeps): Promise<void> {
	const typed = typedCell(args);
	if ("usage" in typed) {
		deps.ui.notify(typed.usage, "warning");
		return;
	}
	const act = typed.act ?? (await picked(deps, typed.address));
	if (act === undefined) return;
	if (act === "go") {
		await goTo(deps, typed.address);
		return;
	}
	if (deps.from === undefined) {
		deps.ui.notify(
			`This session isn't on the mesh, so it can't ${act} ${typed.address}.`,
			"warning",
		);
		return;
	}
	const steered = await deps.steer(typed.address, act, {
		from: deps.from,
		own: deps.own,
	});
	deps.ui.notify(
		steered.ok
			? `${typed.address} on ${steered.machine} was told to ${act === "hold" ? "hold once its turn ends" : "wake and carry on"}, as ${deps.from} asked.`
			: `${typed.address} wasn't told: ${steered.reason}`,
		steered.ok ? "info" : "warning",
	);
}

/** The act he picks for `address`, or none. */
async function picked(
	deps: CellDeps,
	address: string,
): Promise<CellAct | "go" | undefined> {
	const choice = await deps.ui.select(
		address,
		OFFERED.map(([, label]) => label),
	);
	return OFFERED.find(([, label]) => label === choice)?.[0];
}

/**
 * Go to the cell `address`, on the machine the node says runs it. A
 * session goes by its signing address and by the one its id gives, so
 * either finds it.
 */
async function goTo(deps: CellDeps, address: string): Promise<void> {
	const sessions = await deps.sessions();
	const wanted = address.toUpperCase();
	const found = sessions?.find(
		(session) =>
			session.address?.toUpperCase() === wanted ||
			sessionAddress(session.id) === wanted,
	);
	if (sessions === undefined) {
		deps.ui.notify(
			`The node didn't say where ${wanted} runs, so going to it on ${deps.machine}.`,
			"info",
		);
	}
	const machine = found?.machine ?? deps.machine;
	const link = cellLink(address, machine);
	if (link === undefined) {
		deps.ui.notify(
			`${oneLine(address)} on ${oneLine(machine) || "no machine"} isn't a cell the map can go to.`,
			"warning",
		);
		return;
	}
	try {
		const ran = await deps.exec("xdg-open", [link], {
			timeout: OPEN_TIMEOUT_MS,
			cwd: "/",
		});
		// pi's exec answers a run its clock killed with code 0.
		if (ran.code !== 0 || ran.killed) {
			deps.ui.notify(
				ran.killed
					? `${address} didn't open within ${OPEN_TIMEOUT_MS / 1000} s: ${link}`
					: `${address} didn't open (${ran.code}): ${oneLine(ran.stderr) || link}`,
				"warning",
			);
		}
	} catch (error) {
		deps.ui.notify(
			`${address} didn't open: ${oneLine(String(error))}`,
			"warning",
		);
	}
}

/** What /cell runs on in a live session: the node at `socket`. */
export function liveCellDeps(
	pi: Pick<ExtensionAPI, "exec">,
	ui: CellDeps["ui"],
	socket: string | undefined,
	from: string | undefined,
	own: readonly string[],
	machine: string,
): CellDeps {
	return {
		exec: (command, args, options) => pi.exec(command, args, options),
		ui,
		from,
		own,
		sessions: () => nodeSessionsAt(socket),
		steer: (address, act, signer) => steerCell(socket, address, act, signer),
		machine,
	};
}

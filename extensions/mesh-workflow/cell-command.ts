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
import {
	type CellAct,
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
	/** The sessions the node holds, or nothing when none answers. */
	readonly sessions: () => Promise<readonly NodeSession[] | undefined>;
	readonly steer: (
		address: string,
		act: CellAct,
		from: string,
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
	const steered = await deps.steer(typed.address, act, deps.from);
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

/** Go to the cell `address`, on the machine the node says runs it. */
async function goTo(deps: CellDeps, address: string): Promise<void> {
	const sessions = await deps.sessions();
	const machine =
		sessions?.find(
			(session) => session.address?.toUpperCase() === address.toUpperCase(),
		)?.machine ?? deps.machine;
	const link = `mycelium:cell/${address.toUpperCase()}@${machine}/go`;
	try {
		const ran = await deps.exec("xdg-open", [link], {
			timeout: OPEN_TIMEOUT_MS,
		});
		if (ran.code !== 0) {
			deps.ui.notify(
				`${address} didn't open (${ran.code}): ${oneLine(ran.stderr) || link}`,
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
	machine: string,
): CellDeps {
	return {
		exec: (command, args, options) => pi.exec(command, args, options),
		ui,
		from,
		sessions: () => nodeSessionsAt(socket),
		steer: (address, act, signedBy) =>
			steerCell(socket, address, act, signedBy),
		machine,
	};
}

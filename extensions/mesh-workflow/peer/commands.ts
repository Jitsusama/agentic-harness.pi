/**
 * The peer on screen and at the prompt: how its glances and notes draw,
 * and the /host, /needs, /cell and /mesh commands.
 */

import { hostname } from "node:os";
import { senderIdentity } from "../../../lib/mesh/message.ts";
import { agentsAt, nodeSocket } from "../../../lib/mesh/node.ts";
import { expandable } from "../../../lib/ui/expandable.ts";
import { cellCommand, liveCellDeps } from "../cell-command.ts";
import { GLANCE, NOTED } from "../delivery.ts";
import { moveIntoHost, probeHost, startTakeUp } from "../host-command.ts";
import { needsCommand } from "../needs-command.ts";
import {
	type Folding,
	folds,
	QUIET,
	quietSaid,
	quietWanted,
} from "../quiet.ts";
import { meshLines, type Shown } from "../render.ts";
import type { Handing } from "./handing.ts";
import type { MeshState } from "./mesh.ts";

/** A glance on screen: one dim line, cut to the terminal's width. */
/** What the screen draws for a thing that is the model's alone. */
const NOTHING_SHOWN = { render: () => [], invalidate: () => {} };

/** A message's content as text, whichever shape it was sent in. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && "text" in part
				? String((part as { text: unknown }).text)
				: "",
		)
		.join("\n");
}

/** Register how this peer draws and the commands it answers. */
export function registerCommands(m: MeshState, f: Handing) {
	// A glance is the model's: on screen it is nothing (see render.ts).
	m.pi.registerEntryRenderer?.(GLANCE, () => NOTHING_SHOWN);
	// While quiet, a delivery that only tells draws nothing (see quiet.ts).
	m.pi.registerMessageRenderer?.<Shown & Folding>(
		NOTED,
		// Expanded (ctrl+o, as for tool output), quiet keeps nothing off.
		(message, options, theme) =>
			m.quiet && !options.expanded && folds(message.details)
				? NOTHING_SHOWN
				: expandable(message, options.expanded, (width, expanded) =>
						meshLines(
							textOf(message.content),
							message.details,
							theme,
							width,
							expanded,
						),
					),
	);
	// Into a host from inside the window, in place (host-command.ts).
	m.pi.registerCommand?.("host", {
		description:
			"/host [attended|background]: move this session into that host, the background one unless said, keeping this window; it waits for the session to settle first.",
		handler: async (args, at) => {
			const refusal = await moveIntoHost(args, {
				session: () => m.peer?.session,
				hostedIn: () => m.hostKey,
				moving: () => m.peer?.moving,
				sessionFile: () => at.sessionManager.getSessionFile(),
				handOver: m.handOver,
				env: m.env,
				pid: senderIdentity().pid,
				args: process.argv.slice(2),
				machine: hostname().split(".")[0] ?? "",
				agents: () => agentsAt(nodeSocket(m.env)),
				probe: probeHost,
				move: (to) => m.moving.move(to, "here"),
				takeUp: (session, to) => startTakeUp(session, to, m.paths.mesh, m.env),
			});
			if (refusal !== undefined) at.ui.notify(refusal, "warning");
		},
	});
	// What waits on the person, acted on as he types it (needs-command.ts).
	m.pi.registerCommand?.("needs", {
		description:
			"/needs: what waits on you across the machine, the cells that need you and your look list; pick one to go to its cell, or to open or clear a look.",
		handler: (_args, at) =>
			needsCommand({
				exec: (command, args, options) => m.pi.exec(command, args, options),
				looks: m.paths.looks,
				ui: at.ui,
			}),
	});
	// Another cell, gone to, held or woken as he types it (cell-command.ts).
	m.pi.registerCommand?.("cell", {
		description:
			"/cell ADDRESS [go|hold|wake]: go to another session's window, hold it once its turn ends, or wake it to carry on; with no act, pick one.",
		handler: (args, at) =>
			cellCommand(
				args,
				liveCellDeps(
					m.pi,
					at.ui,
					nodeSocket(m.env),
					m.peer?.signature,
					hostname().split(".")[0] ?? "",
				),
			),
	});
	m.pi.registerCommand?.("mesh", {
		description:
			"/mesh quiet [on|off]: keep other sessions' fyis and findings off this screen; questions, holds and pivots still show, and the model reads them all.",
		handler: async (args, at) => {
			const wanted = quietWanted(args, m.quiet);
			if (wanted === undefined) {
				at.ui.notify("Usage: /mesh quiet [on|off]", "warning");
				return;
			}
			m.quiet = wanted;
			m.pi.appendEntry(QUIET, { on: m.quiet });
			f.showQuiet();
			at.ui.notify(quietSaid(m.quiet), "info");
		},
	});
}

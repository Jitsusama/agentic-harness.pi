/**
 * Spawn on a chosen machine: the session is started held by the
 * machine's mycelium node (Jitsusama/mycelium), through that machine's
 * own node when it is another, and a terminal here is opened on the
 * words the node answers that join it. Closing that window leaves the
 * session running, and the words join it again from any terminal.
 *
 * The window is an ordinary terminal driver's, running those words, so
 * no terminal driver knows of mycelium. A held session's own terminal is
 * its holder rather than kitty, so a session it spawns in turn opens a
 * new window rather than a tab beside it.
 *
 * Spawn can also say what the machine must be rather than which it is:
 * the node is asked where that goes first, since spawn must know the
 * machine to choose between resuming here and starting fresh, and the
 * start then names the machine chosen. A dry run asks only where.
 */

import { hostname } from "node:os";
import { relative } from "node:path";
import { shellQuote } from "../../../lib/core/internal/terminal/drivers/shared.ts";
import {
	type NodeStarted,
	nodeSocket,
	placeAt,
	type StartAnswer,
	startAt,
} from "../../../lib/mesh/node.ts";
import {
	type Need,
	needFrom,
	needWords,
	type PlaceAnswer,
} from "../../../lib/mesh/placement.ts";
import {
	describePlan,
	type OpenedTerminal,
	type OpenOptions,
	openTerminal,
	type TerminalLayout,
} from "../../../lib/terminal/index.ts";

/** What a held spawn is asked: where, what, and how its window opens. */
export interface HeldSpawn {
	/** The machine to start on, as its node names it. */
	readonly machine: string;
	/** What the machine was chosen for, if the node chose it. */
	readonly needs: readonly Need[];
	/** The shell command the session runs, as spawn resolved it. */
	readonly command: string;
	/** The folder spawn resolved, on this machine. */
	readonly cwd: string;
	/** The person's home here. */
	readonly home: string;
	/** The quest the new session loads. */
	readonly questId: string;
	readonly layout?: TerminalLayout;
	readonly options: OpenOptions;
}

/** What came of a held spawn, for spawn to say. */
export type HeldSpawnOutcome =
	| { readonly ok: false; readonly refusal: string }
	| {
			readonly ok: true;
			readonly planned: boolean;
			readonly message: string;
			readonly details: Record<string, unknown>;
	  };

/** How a held spawn asks a node to start; the machine's node by default. */
export type StartOnNode = (
	start: Parameters<typeof startAt>[1],
) => Promise<StartAnswer>;

const askTheNode: StartOnNode = (start) => startAt(nodeSocket(), start);

/** How spawn asks a node where work goes; the machine's node by default. */
export type PlaceOnNode = (needs: readonly Need[]) => Promise<PlaceAnswer>;

const askWhere: PlaceOnNode = (needs) => placeAt(nodeSocket(), needs);

/** The machine a spawn starts on, and what it was chosen for. */
export type Chosen =
	| { readonly ok: false; readonly refusal: string }
	| {
			readonly ok: true;
			readonly machine: string | undefined;
			readonly needs: readonly Need[];
	  };

/**
 * The machine a spawn asking `machine` and needing `words` starts on:
 * the one asked when it needs nothing more, else wherever the node
 * places work needing all of them, the machine asked among them.
 */
export async function machineFor(
	machine: string | undefined,
	words: readonly string[],
	place: PlaceOnNode = askWhere,
): Promise<Chosen> {
	const needs: Need[] = [];
	for (const word of words) {
		const read = needFrom(word.trim());
		if (!read.ok) return { ok: false, refusal: `${read.reason}.` };
		needs.push(read.need);
	}
	const other = needs.find(
		(need) => need.kind === "machine" && need.value !== machine,
	);
	if (machine !== undefined && other !== undefined) {
		return {
			ok: false,
			refusal: `machine names ${machine} but needs names ${needWords(other)}, and a session starts on one machine; name it once.`,
		};
	}
	if (needs.length === 0) return { ok: true, machine, needs };
	const all: Need[] =
		machine === undefined
			? needs
			: [...needs, { kind: "machine", value: machine }];
	const answer = await place(all);
	if (!answer.ok) {
		return {
			ok: false,
			refusal: `Nothing was started, since mycelium's node placed it nowhere: ${answer.reason}.`,
		};
	}
	return { ok: true, machine: answer.machine, needs };
}

/** What a spawn's machine was chosen for, as a sentence, or nothing. */
function chosenFor(asked: HeldSpawn): string {
	if (asked.needs.length === 0) return "";
	return `The node chose ${asked.machine} for ${asked.needs.map(needWords).join(", ")}. `;
}

/** Whether `machine` names this one, as its node names it by default. */
export function isThisMachine(
	machine: string,
	name: string = hostname(),
): boolean {
	return machine === name.split(".")[0];
}

/**
 * The folder a start names for `machine`: this machine's own folder as
 * it is, or for another the folder's place within home, since that
 * machine's home is elsewhere (/home/joel here is /Users/joel on a
 * Mac). A folder outside home names nothing there, so its node begins
 * the session in its home.
 */
export function folderFor(
	cwd: string,
	home: string,
	here: boolean,
): string | undefined {
	if (here) return cwd;
	const within = relative(home, cwd);
	if (within === "" || within.startsWith("..") || within.startsWith("/")) {
		return undefined;
	}
	return within;
}

/**
 * The words a node runs: the command through `sh`, with the quest to
 * load said in its environment, since the node's environment is not
 * this session's.
 */
export function heldWords(command: string, questId: string): string[] {
	return ["env", `QUEST_WORKFLOW_AUTOLOAD_ID=${questId}`, "sh", "-c", command];
}

/** The node's attach words as a line a login shell runs as given. */
export function joinLine(attach: readonly string[]): string {
	return attach.map(shellQuote).join(" ");
}

/**
 * Starts the session held on `asked.machine` and opens a terminal here
 * joined to it, or, on a dry run, says what it would do and asks the
 * node nothing.
 */
export async function spawnHeld(
	asked: HeldSpawn,
	start: StartOnNode = askTheNode,
): Promise<HeldSpawnOutcome> {
	const here = isThisMachine(asked.machine);
	const folder = folderFor(asked.cwd, asked.home, here);
	const where = folder ?? "its home";
	if (asked.options.dryRun) {
		const planned = await openTerminal(
			{ ...(asked.layout ? { layout: asked.layout } : {}), cwd: asked.home },
			asked.options,
		);
		return {
			ok: true,
			planned: true,
			message: `${chosenFor(asked)}Would ask ${asked.machine}'s mycelium node to start a held session in ${where}, running: ${asked.command}; then open a ${planned.plan.layout} through ${describePlan(planned.plan)} on the words it answers. Nothing was started.`,
			details: {
				machine: asked.machine,
				needs: asked.needs.map(needWords),
				folder: folder ?? null,
				command: asked.command,
				plan: planned.plan,
			},
		};
	}
	const answer = await start({
		machine: asked.machine,
		needs: asked.needs,
		...(folder !== undefined ? { folder } : {}),
		command: heldWords(asked.command, asked.questId),
	});
	if (!answer.ok) {
		return {
			ok: false,
			refusal: `Nothing was started on ${asked.machine}: ${answer.reason}.`,
		};
	}
	return joined(asked, answer.started, here);
}

/** Opens a terminal here on the words that join a session started held. */
async function joined(
	asked: HeldSpawn,
	started: NodeStarted,
	here: boolean,
): Promise<HeldSpawnOutcome> {
	const line = joinLine(started.attach);
	const held = `${started.machine} holds it as ${started.held}, begun in ${started.folder || "its home"}`;
	let opened: OpenedTerminal;
	try {
		opened = await openTerminal(
			{
				...(asked.layout ? { layout: asked.layout } : {}),
				command: line,
				cwd: here ? asked.cwd : asked.home,
			},
			asked.options,
		);
	} catch (err) {
		return {
			ok: false,
			refusal: `The session started held (${held}), but its window didn't open: ${err instanceof Error ? err.message : String(err)}. Join it from a terminal with: ${line}`,
		};
	}
	const noted = opened.notes.map((note) => ` Note: ${note}.`).join("");
	return {
		ok: true,
		planned: false,
		message: `${chosenFor(asked)}Started a held session on ${started.machine} (${held}) and opened a ${opened.plan.layout} joined to it through ${describePlan(opened.plan)}. Closing the window leaves it running; join it again with: ${line}.${noted}`,
		details: {
			machine: started.machine,
			needs: asked.needs.map(needWords),
			held: started.held,
			folder: started.folder,
			attach: started.attach,
			driver: opened.plan.terminal,
			layout: opened.plan.layout,
			how: opened.how,
		},
	};
}

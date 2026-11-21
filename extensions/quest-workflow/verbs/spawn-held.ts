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
 *
 * A spawn that names neither asks the node too, so work goes where there
 * is room: on 15 November 115 sessions ran on optimus and 3 on the work
 * Mac while the node would have picked the Mac (WCJQSG [66388615]). One
 * started on another machine has its quest shared there first, carries
 * its first words in the start, since the file spawn leaves here names
 * nothing there, and opens no window, even when asked: one opened here
 * for a session there lands on Joel's screen (WM4KSZ [a124c9cb]; Joel,
 * 18:45 on 15 November).
 *
 * Each ask of the node says the fence the session declares it runs in
 * (fence-declaration.ts), which the node judges where it may go by; a
 * fresh session whose fence was declared starts with `PI_SANDBOX` set
 * to it.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { relative } from "node:path";
import { type Exec, spawnExec } from "../../../lib/core/exec/index.ts";
import { shellQuote } from "../../../lib/core/internal/terminal/drivers/shared.ts";
import type {
	DeclaredFence,
	FenceDeclaration,
} from "../../../lib/internal/fence/fence-declaration.ts";
import { declaredSandbox } from "../../../lib/internal/fence/fence-lifted.ts";
import {
	FIRST_TEXT_VARIABLE,
	FIRST_WORDS_VARIABLE,
} from "../../../lib/internal/quest/sessions/first-words.ts";
import {
	agentsAt,
	type NodeStart,
	type NodeStarted,
	nodeSocket,
	placeAt,
	placeToStartAt,
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
	/** The fence the session declares it runs in, told to the node. */
	readonly fence?: FenceDeclaration;
	/**
	 * The sandbox its commands run in, as `PI_SANDBOX` names it, when a
	 * fresh session's fence was declared (`sandboxFor`).
	 */
	readonly sandbox?: DeclaredFence;
	/** The shell command the session runs, as spawn resolved it. */
	readonly command: string;
	/** The folder spawn resolved, on this machine. */
	readonly cwd: string;
	/** The person's home here. */
	readonly home: string;
	/** The quest the new session loads. */
	readonly questId: string;
	/**
	 * The token naming the first words spawn left for the session, when
	 * it left some (lib/internal/quest/sessions/first-words.ts).
	 */
	readonly firstWords?: string;
	/**
	 * The first words themselves, for a session on another machine, where
	 * no file this machine left can reach it.
	 */
	readonly firstText?: string;
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

/**
 * How long a start the node never answered is asked again under its
 * name: it lands within the node's own patience or not at all, and a
 * spawn asked again after this is meant afresh.
 */
const UNANSWERED_FOR_MS = 10 * 60_000;

/**
 * The names this process gives the starts it asks of a node: each start
 * a name of its own, but a start asked again while one just like it went
 * unanswered takes that one's name, so the node answers the start that
 * may still be landing rather than starting a second (KP0L6A, 19
 * November: a start answered after 45 s landed, and the retry started
 * another).
 */
export interface StartNames {
	/** The name to ask `start` under. */
	nameFor(start: Omit<NodeStart, "once">): string;
	/** Hears how the start asked under `name` was answered. */
	heard(name: string, answer: StartAnswer): void;
}

/**
 * A start as spawn asks it, as a key for one just like it. The key a
 * spawn here leaves its first words under is new each time, so it is left
 * out: a start asked again is told as the first was.
 */
function likeness(start: Omit<NodeStart, "once">): string {
	return JSON.stringify([
		start.machine,
		start.needs ?? [],
		start.fence ?? null,
		start.folder ?? null,
		start.command.filter(
			(word) => !word.startsWith(`${FIRST_WORDS_VARIABLE}=`),
		),
	]);
}

/** Start names kept in memory, judged by the clock `now`. */
export function startNames(now: () => number = Date.now): StartNames {
	// Each start still being asked, by name, with its likeness; a start
	// just like one in flight is another start, so it is named afresh.
	const asking = new Map<string, string>();
	// Each start the node took and never answered, by likeness, till it
	// is asked again or its time is up.
	const unanswered = new Map<string, { name: string; at: number }>();
	return {
		nameFor(start) {
			for (const [like, one] of unanswered) {
				if (now() - one.at >= UNANSWERED_FOR_MS) unanswered.delete(like);
			}
			const like = likeness(start);
			const name = unanswered.get(like)?.name ?? randomUUID();
			unanswered.delete(like);
			asking.set(name, like);
			return name;
		},
		heard(name, answer) {
			const like = asking.get(name);
			asking.delete(name);
			if (like !== undefined && !answer.ok && answer.mayLand) {
				unanswered.set(like, { name, at: now() });
			}
		},
	};
}

const namesHere = startNames();

/** How spawn asks a node where work goes; the machine's node by default. */
export type PlaceOnNode = (
	needs: readonly Need[],
	fence?: FenceDeclaration,
) => Promise<PlaceAnswer>;

/**
 * Where, counting nothing: work placed with needs starts through the
 * node's own start wherever it goes, which counts it there.
 */
const askWhere: PlaceOnNode = (needs, fence) =>
	placeAt(nodeSocket(), needs, undefined, fence);

/**
 * Where, for a spawn that starts here itself when the node answers this
 * machine: the node counts that answer as a start, so the next spawn of
 * a burst weighs it rather than being told the same machine before the
 * session shows.
 */
const askToStart: PlaceOnNode = (needs, fence) =>
	placeToStartAt(nodeSocket(), needs, undefined, fence);

/** How a spawn shares its quest with the machines this one links with. */
export type ShareQuest = (
	questId: string,
) => Promise<{ readonly ok: true } | { readonly ok: false; reason: string }>;

/** How long sharing a quest may take before the spawn goes on without. */
const SHARE_PATIENCE_MS = 60_000;

/** Shares `questId` through mycelium, saying why when it couldn't. */
export function shareThrough(exec: Exec): ShareQuest {
	return async (questId) => {
		const { code, stdout, stderr } = await exec("mycelium", ["share", questId]);
		if (code === 0) return { ok: true };
		const said = (stderr.trim() || stdout.trim()).split("\n").at(-1);
		return { ok: false, reason: said || `mycelium share exited ${code}` };
	};
}

const shareByMycelium: ShareQuest = shareThrough(
	spawnExec({ timeoutMs: SHARE_PATIENCE_MS }),
);

/** What a spawn already asked for, which keeps it on this machine. */
export interface StaysAsked {
	/** A session of the quest's resumes here, with its history. */
	readonly resumes: boolean;
	/** A host the call named, which is this machine's. */
	readonly host?: string;
	/** A command the call named, of the caller's own. */
	readonly command?: string;
	/** Only a plan is asked for, so nothing starts to be counted. */
	readonly dryRun?: boolean;
	/** The fence it declares, which the node places it by. */
	readonly fence?: FenceDeclaration;
}

/**
 * The machine a spawn starts on once `machineFor` chose `machine` for
 * `needs`: that one, or with neither, wherever the node places work that
 * needs nothing, when that is another machine. A session that resumes
 * here, a host or a command the call named keep it here, and so does a
 * node that places it here or doesn't answer. A quest needing Joel's
 * screen, Linux or KVM says so in its needs, which the node was asked.
 */
export async function machineByDefault(
	machine: string | undefined,
	needs: readonly Need[],
	asked: StaysAsked,
	place: PlaceOnNode = asked.dryRun ? askWhere : askToStart,
	name: string = hostname(),
): Promise<string | undefined> {
	if (machine !== undefined || needs.length > 0) return machine;
	if (asked.resumes || asked.host?.trim() || asked.command?.trim()) {
		return undefined;
	}
	const answer = await place([], asked.fence);
	return answer.ok && !isThisMachine(answer.machine, name)
		? answer.machine
		: undefined;
}

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
	fence?: FenceDeclaration,
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
	const answer = await place(all, fence);
	if (!answer.ok) {
		return {
			ok: false,
			refusal: `Nothing was started, since mycelium's node placed it nowhere: ${answer.reason}.`,
		};
	}
	return { ok: true, machine: answer.machine, needs };
}

/** How spawn asks which command starts an agent session on each machine. */
export type AgentsOnNode = () => Promise<
	ReadonlyMap<string, string> | undefined
>;

const askAgents: AgentsOnNode = () => agentsAt(nodeSocket());

/**
 * `command` as `machine` starts an agent session in this session's realm:
 * spawn's own `pi`, fresh or resuming, becomes the command the machine's
 * node declares, which is pi-claude in the realm Joel's own Claude plan
 * works in, so a session there stays off the work mesh. A command the
 * call named, a machine that declares none, and a node that doesn't
 * answer all keep the command as it is.
 */
export async function agentCommand(
	command: string,
	machine: string,
	agents: AgentsOnNode = askAgents,
): Promise<string> {
	if (!opensWithPi(command)) return command;
	const agent = (await agents())?.get(machine);
	return agent && agent !== "pi" ? `${agent}${command.slice(2)}` : command;
}

/**
 * Whether a command opens with the word `pi`, alone or with flags: the
 * word a node's agent takes the place of, and what a holder's `--` must
 * be followed by. Not whether a fence reaches what it runs, which
 * spawn-stage.ts's `runsPi` answers more strictly.
 */
function opensWithPi(command: string): boolean {
	return command === "pi" || command.startsWith("pi ");
}

/**
 * Programs that start the command after their `--` in place of
 * themselves, so a pi there is the session the spawn starts.
 */
const HOLDERS = new Set(["mycelium"]);

/**
 * Whether a command ends up starting pi: pi itself, or pi after a
 * holder's `--`, as `mycelium --realm work hold -- pi --model ...`. On
 * 11-07 two sessions spawned that way were never told their notes.
 */
export function startsPi(command: string): boolean {
	if (opensWithPi(command)) return true;
	const [program] = command.trim().split(/\s+/);
	if (!program || !HOLDERS.has(program)) return false;
	const after = command.indexOf(" -- ");
	return after >= 0 && opensWithPi(command.slice(after + 4).trim());
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
 * load, and the token naming its first words when spawn left some, said
 * in its environment, since the node's environment is not this
 * session's.
 */
export function heldWords(
	command: string,
	questId: string,
	firstWords?: string,
	firstText?: string,
	sandbox?: DeclaredFence,
): string[] {
	return [
		"env",
		`QUEST_WORKFLOW_AUTOLOAD_ID=${questId}`,
		...(firstWords ? [`${FIRST_WORDS_VARIABLE}=${firstWords}`] : []),
		...(firstText ? [`${FIRST_TEXT_VARIABLE}=${firstText}`] : []),
		...Object.entries(declaredSandbox(sandbox)).map(
			([name, value]) => `${name}=${value}`,
		),
		"sh",
		"-c",
		command,
	];
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
	share: ShareQuest = shareByMycelium,
	names: StartNames = namesHere,
): Promise<HeldSpawnOutcome> {
	const here = isThisMachine(asked.machine);
	const folder = folderFor(asked.cwd, asked.home, here);
	const where = folder ?? "its home";
	const window = here;
	if (asked.options.dryRun) {
		const sharing = here ? "" : `run mycelium share ${asked.questId}, then `;
		if (!window) {
			return {
				ok: true,
				planned: true,
				message: `${chosenFor(asked)}Would ${sharing}ask ${asked.machine}'s mycelium node to start a held session in ${where}, running: ${asked.command}, and open no window. Nothing was started.`,
				details: {
					machine: asked.machine,
					needs: asked.needs.map(needWords),
					fence: asked.fence ?? null,
					folder: folder ?? null,
					command: asked.command,
				},
			};
		}
		const planned = await openTerminal(
			{ ...(asked.layout ? { layout: asked.layout } : {}), cwd: asked.home },
			asked.options,
		);
		return {
			ok: true,
			planned: true,
			message: `${chosenFor(asked)}Would ${sharing}ask ${asked.machine}'s mycelium node to start a held session in ${where}, running: ${asked.command}; then open a ${planned.plan.layout} through ${describePlan(planned.plan)} on the words it answers. Nothing was started.`,
			details: {
				machine: asked.machine,
				needs: asked.needs.map(needWords),
				fence: asked.fence ?? null,
				folder: folder ?? null,
				command: asked.command,
				plan: planned.plan,
			},
		};
	}
	// Its record and scratch go first, so the session finds its quest as it
	// loads; one that can't be shared still starts, and says so.
	const shared = here ? { ok: true as const } : await share(asked.questId);
	const unshared = shared.ok
		? ""
		: ` Its quest wasn't shared there (${shared.reason}), so it starts without the quest's record; run mycelium share ${asked.questId} to give it one.`;
	const starting = {
		machine: asked.machine,
		needs: asked.needs,
		...(asked.fence ? { fence: asked.fence } : {}),
		...(folder !== undefined ? { folder } : {}),
		command: heldWords(
			asked.command,
			asked.questId,
			asked.firstWords,
			here ? undefined : asked.firstText,
			asked.sandbox,
		),
	};
	const once = names.nameFor(starting);
	const answer = await start({ ...starting, once });
	names.heard(once, answer);
	if (!answer.ok && answer.mayLand) {
		return {
			ok: false,
			refusal: `No answer came from ${asked.machine}'s start: ${answer.reason}. It may still start there, so look for it there before spawning it again. Spawned again within ten minutes, it is asked under the same name, which a node that knows start names answers with that start rather than starting another; an older node starts another.${unshared}`,
		};
	}
	if (!answer.ok) {
		return {
			ok: false,
			refusal: `Nothing was started on ${asked.machine}: ${answer.reason}.${unshared}`,
		};
	}
	const outcome = window
		? await joined(asked, answer.started, here)
		: leftHeld(asked, answer.started);
	return outcome.ok
		? { ...outcome, message: `${outcome.message}${unshared}` }
		: { ...outcome, refusal: `${outcome.refusal}${unshared}` };
}

/**
 * Says where a session started held on another machine runs, with no
 * window opened: one opened here would land on Joel's screen.
 */
function leftHeld(asked: HeldSpawn, started: NodeStarted): HeldSpawnOutcome {
	const line = joinLine(started.attach);
	return {
		ok: true,
		planned: false,
		message: `${chosenFor(asked)}Started a held session on ${started.machine} (${started.machine} holds it as ${started.held}, begun in ${started.folder || "its home"}). No window was opened; join it with: ${line}.`,
		details: {
			machine: started.machine,
			needs: asked.needs.map(needWords),
			fence: asked.fence ?? null,
			held: started.held,
			folder: started.folder,
			attach: started.attach,
			how: "held",
		},
	};
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
			fence: asked.fence ?? null,
			held: started.held,
			folder: started.folder,
			attach: started.attach,
			driver: opened.plan.terminal,
			layout: opened.plan.layout,
			how: opened.how,
		},
	};
}

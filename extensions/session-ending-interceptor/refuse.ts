/**
 * What an ask, a look or a reply says to the person, read for asks to
 * end a machine's sessions, and the refusal of one the node says would
 * end others. A spare stands only where every command shown to the
 * person is plain (plain.ts), and each spare, or a spare that couldn't
 * stand, is traced.
 */

import { isRecord } from "../../lib/internal/record.ts";
import {
	asksInCommand,
	asksInLabel,
	asksInProse,
	codeBesideAsks,
	mayAsk,
	type SessionEndingAsk,
} from "../../lib/internal/session-ending/asks.ts";
import {
	type Here,
	machinesKnown,
	type Refusal,
	refusalOf,
	type Spared,
	sparedBy,
} from "../../lib/internal/session-ending/judge.ts";
import {
	commandNamedIn,
	notPlainIn,
} from "../../lib/internal/session-ending/plain.ts";
import type { NodeSession } from "../../lib/mesh/node.ts";

/** Where the interceptor reads the node and names this machine. */
export interface SessionEndingDeps {
	/**
	 * Whether a realm is named for a node to serve: with none, as for a
	 * consumer without mycelium, there is no node to ask and nothing is
	 * refused.
	 */
	readonly onMesh: () => boolean;
	/** Every session the node holds, or nothing when it can't be read. */
	readonly sessions: () => Promise<readonly NodeSession[] | undefined>;
	/**
	 * Every machine the realm holds, sessions on it or not, so an ask of
	 * an empty one reads as naming it, with those its nodes named before;
	 * nothing when the node can't say.
	 */
	readonly machines: () => Promise<readonly string[] | undefined>;
	/** This machine's name, for an ask read while the node can't be. */
	readonly here: () => string;
	/**
	 * What spares this machine's sessions from an ask: a log-out that
	 * leaves the user's services running, and the sessions whose presence
	 * says they parked. Asked only of an ask that would be refused
	 * without it; without it, nothing is.
	 */
	readonly spares?: () => Promise<Spares>;
}

/**
 * What spares this machine's sessions, and what of it couldn't be read:
 * a parked read that failed leaves none parked, while what lingers,
 * read apart from it, still spares a log-out.
 */
export interface Spares extends Omit<Here, "machine"> {
	readonly unread?: string;
}

/** An ask as a trace names it: its act and the machines it names. */
interface AskTraced {
	readonly act: SessionEndingAsk["act"];
	readonly machines: readonly string[];
}

/**
 * What a spare did with an ask that would otherwise be refused: let it
 * past these sessions, or stand on nothing, its read having failed or
 * a command shown not being plain; or what was held after one stood,
 * for naming a command its sessions might not outlive.
 */
export type SpareTrace =
	| {
			readonly outcome: "spared";
			readonly asks: readonly AskTraced[];
			readonly spared: readonly Spared[];
	  }
	| {
			readonly outcome: "unread";
			readonly asks: readonly AskTraced[];
			readonly error: string;
	  }
	| {
			readonly outcome: "not plain";
			readonly asks: readonly AskTraced[];
			/** What wasn't plain: a command, a fence line or a word. */
			readonly shown: string;
	  }
	| {
			readonly outcome: "after a spare";
			/** The command, or the word naming one, that was held. */
			readonly shown: string;
	  };

/** Said in a refusal when what spares sessions couldn't be read. */
const unreadBecause = (why: string) => `None here was spared: ${why}.`;

/** How much of what wasn't plain a refusal quotes. */
const SHOWN_AT_MOST = 60;

/** What a refusal quotes of `shown`: one line, cut short. */
const quotedShown = (shown: string) => {
	const line = shown.replace(/\s+/g, " ").trim();
	return line.length > SHOWN_AT_MOST
		? `${line.slice(0, SHOWN_AT_MOST)}...`
		: line;
};

/**
 * Said in a refusal when what it shows isn't on the plain list, quoting
 * what wasn't.
 */
const notPlainBecause = (shown: string) =>
	`It shows or names a command that isn't a plain reboot, shut-down or log-out ("${quotedShown(shown)}"), so none was spared.`;

/**
 * Why what follows a spare is held, quoting the command it names: the
 * sessions the spare let an ask past outlive only a plain reboot,
 * shut-down or log-out.
 */
const afterASpareBecause = (shown: string) =>
	`An ask to end a machine's sessions was let through earlier in this run, past sessions only a plain reboot, shut-down or log-out spares, and this shows or names a command that isn't one ("${quotedShown(shown)}"), which could end them anyway.`;

/**
 * Why what is said after a spare stood in the run may not go to the
 * person, or nothing when it may: held only where its words name a
 * command that isn't a plain reboot, shut-down or log-out, so a file
 * named in code, or the spared ask said again, still goes. What it
 * held is traced.
 */
export function refusalAfterASpare(
	said: Said,
	traced: (trace: SpareTrace) => void = () => {},
): Refusal | undefined {
	const shown = commandNamedIn([...said.prose, ...said.labels]);
	if (shown === undefined) return undefined;
	traced({ outcome: "after a spare", shown });
	return {
		reason: afterASpareBecause(shown),
		key: `after a spare: ${quotedShown(shown)}`,
	};
}

/**
 * What a call or reply says to the person: prose, read for the form of
 * an ask; labels, which are the ask itself; and commands that will run
 * for them, which end sessions as surely as one they type.
 */
export interface Said {
	readonly prose: readonly string[];
	readonly labels: readonly string[];
	readonly commands?: readonly string[];
	/** The machine its labels are on when they name none, as a wait's. */
	readonly on?: string;
}

const NOTHING: Said = { prose: [], labels: [] };

const texts = (values: readonly unknown[]): string[] =>
	values.filter((value): value is string => typeof value === "string");

/**
 * What the `ask` tool's questions say: each prompt and option
 * description as prose, each question's tab label and each option's
 * label as the ask itself.
 */
export function saidByAsk(input: unknown): Said {
	if (!isRecord(input) || !Array.isArray(input.questions)) return NOTHING;
	const prose: unknown[] = [];
	const labels: unknown[] = [];
	for (const question of input.questions) {
		if (!isRecord(question)) continue;
		prose.push(question.prompt);
		labels.push(question.label);
		const options = Array.isArray(question.options) ? question.options : [];
		for (const option of options) {
			if (!isRecord(option)) continue;
			labels.push(option.label);
			prose.push(option.description);
		}
	}
	return { prose: texts(prose), labels: texts(labels) };
}

/**
 * What a `show_person` look says: its title, why and ask as prose, read
 * for the form of an ask, since a title can name a reboot it only
 * explains, and its choices as the ask itself. Taking a look back asks
 * nothing, whatever it named.
 */
export function saidByLook(input: unknown): Said {
	if (!isRecord(input) || input.withdraw === true) return NOTHING;
	const choices = Array.isArray(input.choices) ? input.choices : [];
	return {
		prose: texts([input.title, input.why, input.ask]),
		labels: texts(choices),
	};
}

/**
 * What a `mesh_wait` says waits on the person. Its title and steps are
 * what they are to do, so the ask itself, each on the machine the wait
 * names; its why and when are prose. When it is done at the next boot,
 * a reboot of that machine is asked too, and the checks it is done or
 * ready by are commands run for the person. Settling an item asks
 * nothing, whatever its title.
 */
export function saidByWait(input: unknown): Said {
	if (!isRecord(input) || input.done === true) return NOTHING;
	const machine = typeof input.machine === "string" ? input.machine : "";
	const steps = Array.isArray(input.steps) ? texts(input.steps) : [];
	const atBoot = isRecord(input.doneWhen) && input.doneWhen.signal === "boot";
	const checks = [input.doneWhen, input.readyWhen].map((when) =>
		isRecord(when) ? when.check : undefined,
	);
	return {
		prose: texts([input.why, input.when]),
		labels: [
			...texts([input.title]),
			...steps.map((step) => step.replace(/[.!?\s]+$/, "")),
			...(atBoot ? ["Reboot"] : []),
		],
		commands: texts(checks),
		...(machine ? { on: machine } : {}),
	};
}

/** What an assistant message's text blocks say, as prose. */
export function saidInReply(content: unknown): Said {
	if (!Array.isArray(content)) return NOTHING;
	const prose = content.flatMap((block: unknown) =>
		isRecord(block) && block.type === "text" && typeof block.text === "string"
			? [block.text]
			: [],
	);
	return { prose, labels: [] };
}

/**
 * The machines `deps`' nodes have named, kept for when none can be
 * read, or only some: otherwise only this machine is known then, so
 * "restart equilibrius" reads as restarting something else and goes
 * through, just when the guard means to refuse. Kept per set of deps;
 * the default deps also keep them on disk, for a fresh start.
 */
const lastKnown = new WeakMap<SessionEndingDeps, readonly string[]>();

/** The machines `deps`' nodes name now, with every one named before. */
function machinesSoFar(
	deps: SessionEndingDeps,
	sessions: readonly NodeSession[] | undefined,
	listed: readonly string[] | undefined,
): string[] {
	const known = [
		...new Set([
			...(lastKnown.get(deps) ?? []),
			...machinesKnown(sessions, listed, deps.here()),
		]),
	];
	lastKnown.set(deps, known);
	return known;
}

/**
 * Why what was said may not go to the person, or nothing when it may.
 * The node is asked only when a word in it could open an ask. What is
 * `beside` it, as the text of the reply making a call, must be as
 * plain as what it says for a spare to stand: the person reads both.
 */
export async function refusalFor(
	said: Said,
	self: string | undefined,
	deps: SessionEndingDeps,
	traced: (trace: SpareTrace) => void = () => {},
	beside: readonly string[] = [],
): Promise<Refusal | undefined> {
	const commands = said.commands ?? [];
	const all = [...said.prose, ...said.labels, ...commands];
	if (!all.some(mayAsk) || !deps.onMesh()) return undefined;
	const [sessions, listed] = await Promise.all([
		deps.sessions(),
		deps.machines(),
	]);
	const machines = machinesSoFar(deps, sessions, listed);
	const read: SessionEndingAsk[] = [
		...said.prose.flatMap((text) => asksInProse(text, machines)),
		...said.labels.flatMap((text) =>
			asksInLabel(text, machines).map((ask) =>
				onItsMachine(ask, said.on, machines),
			),
		),
		...commands.flatMap((line) => asksInCommand(line, machines)),
	];
	// Code in one field asks beside the words of another said with it.
	const asks = [
		...read,
		...codeBesideAsks([...said.prose, ...said.labels], read, machines),
	];
	const refusal = refusalOf(asks, sessions, self);
	if (!refusal || !sessions || !deps.spares) return refusal;
	const named = tracedAsks(asks);
	let notPlain: string | undefined | null = null;
	const shownNotPlain = () => {
		if (notPlain === null)
			notPlain = notPlainIn([...said.prose, ...said.labels, ...beside]);
		return notPlain;
	};
	/**
	 * `base` where what wasn't read couldn't lift it even at its best;
	 * else blamed on what isn't plain, which would refuse a full read
	 * too, or else on what wasn't read.
	 */
	const unreadOr = (base: Refusal, best: Here, why: string): Refusal => {
		if (refusalOf(asks, sessions, self, best)) {
			traced({ outcome: "unread", asks: named, error: why });
			return base;
		}
		const shown = shownNotPlain();
		if (shown !== undefined) {
			traced({ outcome: "not plain", asks: named, shown });
			return because(base, notPlainBecause(shown));
		}
		traced({ outcome: "unread", asks: named, error: why });
		return because(base, unreadBecause(why));
	};
	let here: Here;
	let unread: string | undefined;
	try {
		const { unread: missed, ...spares } = await deps.spares();
		here = { machine: deps.here(), ...spares };
		unread = missed;
	} catch (error) {
		// What spares a session couldn't be read, so it spares none.
		const message = error instanceof Error ? error.message : String(error);
		const best = atBest({ machine: deps.here(), lingers: true }, sessions);
		return unreadOr(refusal, best, message);
	}
	const left = refusalOf(asks, sessions, self, here);
	if (left) {
		if (unread === undefined) return left;
		return unreadOr(left, atBest(here, sessions), unread);
	}
	const shown = shownNotPlain();
	if (shown !== undefined) {
		traced({ outcome: "not plain", asks: named, shown });
		return because(refusal, notPlainBecause(shown));
	}
	const spared = sparedBy(asks, sessions, self, here);
	traced({ outcome: "spared", asks: named, spared });
	return undefined;
}

/**
 * What `here` would be had every session parked: what spares could do
 * at its best. Only where that would lift a refusal does what wasn't
 * read say why none was spared.
 */
function atBest(
	here: Omit<Here, "parked">,
	sessions: readonly NodeSession[],
): Here {
	return { ...here, parked: new Set(sessions.map((one) => one.id)) };
}

/** `refusal` with `why` said after its reason, known by the same key. */
function because(refusal: Refusal, why: string): Refusal {
	return { ...refusal, reason: `${refusal.reason} ${why}` };
}

/** `asks` as a trace names them, each act and machines once. */
function tracedAsks(asks: readonly SessionEndingAsk[]): AskTraced[] {
	const each = new Map<string, AskTraced>();
	for (const { act, machines } of asks) {
		each.set(`${act}:${machines.join(",")}`, { act, machines });
	}
	return [...each.values()];
}

/**
 * An ask that names no machine, as on the one it is said for, when that
 * is a machine the node knows, in any case. One it doesn't know names
 * none, so every machine is checked rather than a name nobody is on.
 */
function onItsMachine(
	ask: SessionEndingAsk,
	on: string | undefined,
	machines: readonly string[],
): SessionEndingAsk {
	const known = machines.find(
		(name) => name.toLowerCase() === on?.trim().toLowerCase(),
	);
	return known && ask.machines.length === 0
		? { ...ask, machines: [known] }
		: ask;
}

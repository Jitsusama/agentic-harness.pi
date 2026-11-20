/**
 * What an ask, a look or a reply says to the person, read for asks to
 * end a machine's sessions, and the refusal of one the node says would
 * end others.
 */

import { isRecord } from "../../lib/internal/record.ts";
import {
	asksInCommand,
	asksInLabel,
	asksInProse,
	mayAsk,
	type SessionEndingAsk,
} from "../../lib/internal/session-ending/asks.ts";
import {
	type Here,
	machinesKnown,
	type Refusal,
	refusalOf,
} from "../../lib/internal/session-ending/judge.ts";
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
	 * What spares this machine's sessions from an ask by the session the
	 * node knows by `address`: a log-out that leaves the user's services
	 * running, and the sessions parked on its standing hold of a
	 * disruption. Asked only of an
	 * ask that would be refused without it; without it, nothing is.
	 */
	readonly spares?: (
		address: string | undefined,
	) => Promise<Omit<Here, "machine">>;
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
 * The node is asked only when a word in it could open an ask.
 */
export async function refusalFor(
	said: Said,
	self: string | undefined,
	deps: SessionEndingDeps,
): Promise<Refusal | undefined> {
	const commands = said.commands ?? [];
	const all = [...said.prose, ...said.labels, ...commands];
	if (!all.some(mayAsk) || !deps.onMesh()) return undefined;
	const [sessions, listed] = await Promise.all([
		deps.sessions(),
		deps.machines(),
	]);
	const machines = machinesSoFar(deps, sessions, listed);
	const asks: SessionEndingAsk[] = [
		...said.prose.flatMap((text) => asksInProse(text, machines)),
		...said.labels.flatMap((text) =>
			asksInLabel(text, machines).map((ask) =>
				onItsMachine(ask, said.on, machines),
			),
		),
		...commands.flatMap((line) => asksInCommand(line, machines)),
	];
	const refusal = refusalOf(asks, sessions, self);
	if (!refusal || !sessions || !deps.spares) return refusal;
	const address = sessions.find((one) => one.id === self)?.address;
	try {
		const here = { machine: deps.here(), ...(await deps.spares(address)) };
		return refusalOf(asks, sessions, self, here);
	} catch {
		// What spares a session couldn't be read, so it spares none.
		return refusal;
	}
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

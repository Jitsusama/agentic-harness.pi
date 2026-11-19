/**
 * What an ask, a look or a reply says to the person, read for asks to
 * end a machine's sessions, and the refusal of one the node says would
 * end others.
 */

import { isRecord } from "../../lib/internal/record.ts";
import {
	asksInLabel,
	asksInProse,
	mayAsk,
	type SessionEndingAsk,
} from "../../lib/internal/session-ending/asks.ts";
import {
	machinesKnown,
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
	/** This machine's name, for an ask read while the node can't be. */
	readonly here: () => string;
}

/**
 * What a call or reply says to the person: prose, read for the form of
 * an ask, and labels, which are the ask itself.
 */
export interface Said {
	readonly prose: readonly string[];
	readonly labels: readonly string[];
}

const NOTHING: Said = { prose: [], labels: [] };

const texts = (values: readonly unknown[]): string[] =>
	values.filter((value): value is string => typeof value === "string");

/**
 * What the `ask` tool's questions say: each prompt and option
 * description as prose, each option's label as the ask itself.
 */
export function saidByAsk(input: unknown): Said {
	if (!isRecord(input) || !Array.isArray(input.questions)) return NOTHING;
	const prose: unknown[] = [];
	const labels: unknown[] = [];
	for (const question of input.questions) {
		if (!isRecord(question)) continue;
		prose.push(question.prompt);
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
 * explains, and its choices as the ask itself.
 */
export function saidByLook(input: unknown): Said {
	if (!isRecord(input)) return NOTHING;
	const choices = Array.isArray(input.choices) ? input.choices : [];
	return {
		prose: texts([input.title, input.why, input.ask]),
		labels: texts(choices),
	};
}

/**
 * What a `mesh_wait` says waits on the person: its title, why, when and
 * steps as prose, each step on the machine it names; and, when it is
 * done at the next boot, a reboot of that machine as the ask itself.
 */
export function saidByWait(input: unknown): Said {
	if (!isRecord(input)) return NOTHING;
	const machine = typeof input.machine === "string" ? input.machine : "";
	const on = machine ? ` on ${machine}` : "";
	const steps = Array.isArray(input.steps) ? texts(input.steps) : [];
	const atBoot = isRecord(input.doneWhen) && input.doneWhen.signal === "boot";
	const title = typeof input.title === "string" ? `: ${input.title}` : "";
	return {
		prose: [
			...texts([input.title, input.why, input.when]),
			...steps.map((step) => `${step.replace(/[.!?\s]+$/, "")}${on}.`),
		],
		labels: atBoot ? [`Reboot${on}${title}`] : [],
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
 * Why what was said may not go to the person, or nothing when it may.
 * The node is asked only when a word in it could open an ask.
 */
export async function refusalFor(
	said: Said,
	self: string | undefined,
	deps: SessionEndingDeps,
): Promise<string | undefined> {
	const all = [...said.prose, ...said.labels];
	if (!all.some(mayAsk) || !deps.onMesh()) return undefined;
	const sessions = await deps.sessions();
	const machines = machinesKnown(sessions, deps.here());
	const asks: SessionEndingAsk[] = [
		...said.prose.flatMap((text) => asksInProse(text, machines)),
		...said.labels.flatMap((text) => asksInLabel(text, machines)),
	];
	return refusalOf(asks, sessions, self);
}

/**
 * Session Ending Interceptor: no ask of the person to end a machine's
 * sessions while others are live there.
 *
 * A log-out, reboot, restart, shutdown or switch of users ends every pi
 * session on the machine, busy or idle. On 18 November a session asked
 * Joel to log out on equilibrius and five sessions ended mid-run. So an
 * `ask`, a `show_person` look or a reply asking for one is refused while
 * the machine's mycelium node says any session other than the asker's
 * is there in any state but ended, and refused when the node can't be
 * read, under the no-session-ending-ask-while-live guard. Every realm's
 * node on the machine is read, since a reboot ends the sessions of all
 * of them. So is a
 * `mesh_wait` putting one on the person's list, or done by a check that
 * ends sessions. Where no realm is named, as for a consumer without
 * mycelium, there is no node and nothing is refused; where one is named
 * and its node can't be found, that is a node that can't be read.
 * Under redirect, the same ask made again goes through, however the
 * sessions it would end have moved between busy and idle since; for a
 * reply, only an ask the model was told of, and only in that run.
 *
 * A call is refused before it runs. A reply has already streamed by the
 * time pi finalizes it, so its text is replaced there, which pi shows
 * in its place and keeps in the session, with its tool calls left as
 * they were; the reason follows once a run as a follow-up, so the model
 * says something else. A reply the person stopped is withheld without
 * one, since the run it would continue was ended on purpose. Each one
 * withheld is said on the bus, since an extension pi ran before this
 * one, as the mesh's talks, may have relayed the text already.
 */

import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { refusalUnder } from "../../lib/guardian/apply.ts";
import { guardMode } from "../../lib/guardian/policy.ts";
import { OVERRIDE_HINT } from "../../lib/guardian/report.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { thisMachine } from "../../lib/internal/machine/machine.ts";
import { isRecord } from "../../lib/internal/record.ts";
import { sayReplyWithheld } from "../../lib/internal/session/withheld.ts";
import {
	machineNamesAt,
	type NodeSession,
	nodeServes,
	nodeSessionsAt,
	nodeSockets,
	realmOf,
} from "../../lib/mesh/node.ts";
import {
	refusalFor,
	type Said,
	type SessionEndingDeps,
	saidByAsk,
	saidByLook,
	saidByWait,
	saidInReply,
} from "./refuse.ts";

export type { SessionEndingDeps } from "./refuse.ts";

const GUARD = GUARDS.noSessionEndingAskWhileLive;

/** What the refusal of a reply is sent as, after the withheld reply. */
export const WITHHELD_MESSAGE = "session-ending-withheld";

/** What stands in a withheld reply's place, when the model is told why. */
const WITHHELD_TOLD =
	"(Withheld: this asked the person to end a machine's sessions. The reason follows.)";

/** What stands in its place when it isn't: stopped, or told already. */
const WITHHELD =
	"(Withheld: this asked the person to end a machine's sessions.)";

/**
 * How a redirected reply's refusal says it may go through: the model no
 * longer has the withheld text, so the same ask, not the same words.
 */
const REPLY_OVERRIDE_HINT =
	"If this is right as it is, ask it again and it will go through as a recorded override.";

/** What reads the tool calls that say something to the person. */
const READERS: Readonly<Record<string, (input: unknown) => Said>> = {
	ask: saidByAsk,
	show_person: saidByLook,
	mesh_wait: saidByWait,
};

/**
 * Whether the model has been told of a withheld reply in this run, so
 * however many are withheld it is told once, until the run settles;
 * which run this is; and the asks it was told of in it, the only ones a
 * reply may override by asking again.
 */
interface Told {
	thisRun: boolean;
	run: string;
	readonly keys: Set<string>;
}

/** The interceptor, reading the node and the machine through `deps`. */
export function sessionEndingInterceptor(deps: SessionEndingDeps) {
	return (pi: ExtensionAPI): void => {
		declareGuards(GUARD);
		const told: Told = { thisRun: false, run: randomUUID(), keys: new Set() };
		pi.on("tool_call", (event, ctx) =>
			refuseCall(event.toolName, event.input, ctx, deps),
		);
		pi.on("message_end", (event, ctx) =>
			withholdReply(pi, event.message, ctx, deps, told),
		);
		pi.on("agent_settled", () => {
			told.thisRun = false;
			told.run = randomUUID();
			told.keys.clear();
		});
	};
}

/**
 * The machine's nodes: the one for the realm `env` names, and any other
 * realm's the machine serves. A realm named with no runtime folder to
 * find its socket in is still on the mesh, so its node reads as one
 * that can't be, and so does every node when any one can't be read.
 */
export function nodeDeps(
	env: NodeJS.ProcessEnv = process.env,
): SessionEndingDeps {
	return {
		onMesh: () => realmOf(env) !== undefined,
		sessions: () => everyRealmsSessions(nodeSockets(env)),
		machines: async () => {
			const each = await Promise.all(
				nodeSockets(env).map((socket) => machineNamesAt(socket)),
			);
			const read = each.filter((names) => names !== undefined);
			return read.length === 0 ? undefined : [...new Set(read.flat())];
		},
		here: () => thisMachine(),
	};
}

/**
 * The sessions every socket's node holds, or nothing when any can't
 * say: the session's own realm's first, which must answer, then each
 * other realm's, of which one whose socket nothing serves any more, as
 * a node that ended leaves behind, holds none.
 */
async function everyRealmsSessions(
	sockets: readonly string[],
): Promise<NodeSession[] | undefined> {
	const [own, ...others] = sockets;
	if (own === undefined) return undefined;
	const each = await Promise.all([
		nodeSessionsAt(own),
		...others.map(async (socket) => {
			const sessions = await nodeSessionsAt(socket);
			if (sessions !== undefined) return sessions;
			return (await nodeServes(socket)) ? undefined : [];
		}),
	]);
	if (each.some((sessions) => sessions === undefined)) return undefined;
	return each.flatMap((sessions) => sessions ?? []);
}

export default sessionEndingInterceptor(nodeDeps());

async function refuseCall(
	toolName: string,
	input: unknown,
	ctx: ExtensionContext,
	deps: SessionEndingDeps,
) {
	const read = READERS[toolName];
	if (!read) return undefined;
	const refusal = await refusalFor(read(input), selfOf(ctx), deps);
	if (!refusal) return undefined;
	return refusalUnder(
		GUARD.name,
		{ block: true, reason: refusal.reason },
		"An ask to end a machine's sessions",
		JSON.stringify(input),
		refusal.key,
	);
}

/**
 * The reply with its text withheld, when it asks to end sessions the
 * node says are live; nothing, leaving it as it was, otherwise. Under
 * redirect, the override is known by the ask alone, since the model
 * can't say again words it no longer has, and only in the run it was
 * told in. A reply withheld without a word to the model keeps none, so
 * an ask it was never told of can't go through as one it chose.
 */
async function withholdReply<M extends { role: string }>(
	pi: ExtensionAPI,
	message: M,
	ctx: ExtensionContext,
	deps: SessionEndingDeps,
	told: Told,
): Promise<{ message: M } | undefined> {
	if (message.role !== "assistant" || !("content" in message)) return undefined;
	const said = saidInReply(message.content);
	const refusal = await refusalFor(said, selfOf(ctx), deps);
	if (!refusal) return undefined;
	const stopped =
		"stopReason" in message &&
		(message.stopReason === "aborted" || message.stopReason === "error");
	const telling = !stopped && !told.thisRun;
	const mode = guardMode(GUARD.name);
	const silent =
		(stopped && mode !== "off") ||
		(!telling && !told.keys.has(refusal.key) && mode === "redirect");
	if (silent) return replaced(pi, message, WITHHELD);
	const verdict = refusalUnder(
		GUARD.name,
		{ block: true, reason: refusal.reason },
		"A reply asking to end a machine's sessions",
		undefined,
		`${refusal.key}@${told.run}`,
	);
	if (!verdict) return undefined;
	if (telling) {
		told.thisRun = true;
		told.keys.add(refusal.key);
		const reason = verdict.reason.replace(OVERRIDE_HINT, REPLY_OVERRIDE_HINT);
		pi.sendMessage(
			{
				customType: WITHHELD_MESSAGE,
				content: `Your last reply was withheld from the person. ${reason} Say what you meant without the ask.`,
				display: true,
			},
			{ deliverAs: "followUp" },
		);
	}
	return replaced(pi, message, telling ? WITHHELD_TOLD : WITHHELD);
}

/**
 * The reply with its text in one notice, said on the bus, so what
 * relayed it before this ran, as a mesh talk, can relay the notice.
 */
function replaced<M extends { role: string; content: unknown }>(
	pi: ExtensionAPI,
	message: M,
	notice: string,
): { message: M } {
	const now = { ...message, content: withheld(message.content, notice) };
	sayReplyWithheld(pi.events, { was: message, now });
	return { message: now };
}

/** A reply's content with its text in one notice, the rest kept. */
function withheld(content: unknown, notice: string): unknown[] {
	const blocks: unknown[] = Array.isArray(content) ? content : [];
	let noted = false;
	return blocks.flatMap((block) => {
		if (!isRecord(block) || block.type !== "text") return [block];
		if (noted) return [];
		noted = true;
		return [{ type: "text", text: notice }];
	});
}

/** The asker's own session, which its ask doesn't end for anyone else. */
function selfOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		// A context without a session (a stand-in, or one torn down)
		// names none, so no session is taken for the asker's.
		return undefined;
	}
}

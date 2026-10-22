/**
 * The mesh in a subagent: its parent's hands (see lib/mesh/hand.ts).
 *
 * Every peer registers this extension with the fleet, which loads it
 * into each subagent it starts, isolated ones included. Here it claims
 * on the board, as the parent's, the files the subagent changes and the
 * heavy work it runs, and tells it of the holds that reach its parent:
 * as it starts, as each hold begins and ends, and once more before any
 * heavy command while one stands. It gives the subagent no tool, no
 * address and no messages of its own.
 */

import { join } from "node:path";
import {
	type ExtensionAPI,
	isToolCallEventType,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { onJobFinished } from "../../lib/jobs/index.ts";
import {
	handIn,
	holdsReaching,
	type StandingHold,
} from "../../lib/mesh/hand.ts";
import {
	createBoard,
	heavyWorkIn,
	LEASE_KINDS,
	type OwnLeases,
	ownLeases,
	RUN_KINDS,
} from "../../lib/mesh/lease.ts";
import { clock, shortId } from "../../lib/mesh/message.ts";
import { createPresences } from "../../lib/mesh/presence.ts";
import { folderTransport } from "../../lib/mesh/transport.ts";
import { NOTED } from "./delivery.ts";
import { type MeshPaths, machinePaths, registerHands } from "./index.ts";
import {
	commandLine,
	createHeavyCalls,
	createLeasing,
	type Leaser,
} from "./leases.ts";

/** How a hand asks the peers it overlaps: through its parent. */
const ASKING = "say so in your answer, for the session that started you";

/** The extension, as a subagent's hands on the mesh at these paths. */
export function meshHand(
	paths: MeshPaths = machinePaths(),
	env: NodeJS.ProcessEnv = process.env,
) {
	return (pi: ExtensionAPI) => {
		const hand = handIn(env);
		if (!hand) return;
		// A subagent's own fleet works for the same peer.
		registerHands(pi.events);
		const transport = folderTransport(join(paths.mesh, "messages"));
		const presences = createPresences(join(paths.mesh, "presence"));
		const board = createBoard(join(paths.mesh, "leases"));
		let own: OwnLeases | undefined;

		/** The parent, as leasing stands it in for this hand. */
		const parent = (): Leaser | undefined => {
			const presence = presences.of(hand.of);
			const signature = presence?.addresses[0];
			return presence && signature
				? { session: hand.of, signature, addresses: presence.addresses }
				: undefined;
		};
		const leasing = createLeasing({
			board,
			presences,
			transport,
			own: () => own,
			peer: parent,
			// Nothing reaches a hand, so nothing it sends needs keeping from it.
			sent: () => {},
			asking: ASKING,
		});
		const say = (content: string) =>
			pi.sendMessage(
				{
					customType: NOTED,
					content,
					display: true,
					details: { messages: [], glanced: [] },
				},
				{ triggerTurn: false },
			);
		const heavyCalls = createHeavyCalls(
			(event) =>
				void leasing
					.heavy(event)
					.then((said) => {
						if (said) say(said);
					})
					.catch(() => {}),
			(command) => `${commandLine(command)}, by a subagent`,
		);

		// The holds this hand was told of, and those a heavy command was
		// stopped for, each once.
		const told = new Set<string>();
		const stoppedFor = new Set<string>();
		const standing = (): StandingHold[] => {
			const presence = presences.of(hand.of);
			if (!presence) return [];
			return holdsReaching(
				board.all(),
				(id) => transport.read(id),
				{ addresses: presence.addresses, groups: presence.groups },
				presence.owner?.pid ?? -1,
				Date.now(),
			);
		};
		/**
		 * What began and ended since the hand was last told, said once; a
		 * hold the hand is told of some other way is not said to begin.
		 */
		const news = (
			holds: readonly StandingHold[],
			saidElsewhere: readonly StandingHold[] = [],
		): string | undefined => {
			for (const { hold } of saidElsewhere) told.add(hold.id);
			const begun = holds.filter(({ hold }) => !told.has(hold.id));
			const over = [...told].filter(
				(id) => !holds.some(({ hold }) => hold.id === id),
			);
			for (const { hold } of begun) told.add(hold.id);
			for (const id of over) told.delete(id);
			const lines = [
				...begun.map(holdBegun),
				...over.map((id) => `The mesh hold [${shortId({ id })}] is over.`),
			];
			return lines.length > 0 ? lines.join("\n\n") : undefined;
		};
		const tell = () => {
			const said = news(standing());
			if (said) say(said);
		};

		pi.on("session_start", async () => {
			own = ownLeases(board, hand.session, Date.now(), hand.of);
		});
		// The holds standing as it starts reach it with its task.
		pi.on("before_agent_start", async () => {
			const said = news(standing());
			return said
				? {
						message: {
							customType: NOTED,
							content: said,
							display: true,
							details: { messages: [], glanced: [] },
						},
					}
				: undefined;
		});
		pi.on("turn_end", async () => {
			tell();
		});

		// Never throws: pi blocks a tool whose handler fails.
		pi.on(
			"tool_call",
			async (event, called): Promise<ToolCallEventResult | undefined> => {
				try {
					const holds = standing();
					if (isToolCallEventType("bash", event)) {
						const command = event.input.command;
						const work =
							typeof command === "string" ? heavyWorkIn(command) : undefined;
						const unheard = holds.filter(
							({ hold }) => !stoppedFor.has(hold.id),
						);
						const blocked = work && unheard.length > 0;
						const said = news(holds, blocked ? unheard : []);
						if (said) say(said);
						if (work && blocked) {
							for (const { hold } of unheard) stoppedFor.add(hold.id);
							return { block: true, reason: heldBack(unheard, work) };
						}
						const why =
							typeof command === "string"
								? await leasing.rewrite(command, called?.cwd ?? process.cwd())
								: undefined;
						if (why) return { block: true, reason: why };
						if (own) heavyCalls.called(event.toolCallId, command);
						return undefined;
					}
					const said = news(holds);
					if (said) say(said);
					const path =
						isToolCallEventType("edit", event) ||
						isToolCallEventType("write", event)
							? event.input.path
							: undefined;
					if (typeof path !== "string" || path === "") return undefined;
					const why = await leasing.reach(path, called?.cwd ?? process.cwd());
					return why ? { block: true, reason: why } : undefined;
				} catch {
					return undefined;
				}
			},
		);
		pi.on("tool_result", async (event) => {
			heavyCalls.answered(event.toolCallId, event.content);
			return undefined;
		});
		if (pi.events) {
			onJobFinished(pi.events, ({ toolCallId }) => {
				if (toolCallId !== undefined) heavyCalls.finished(toolCallId);
			});
		}

		pi.on("agent_end", async () => {
			own?.releaseAll(RUN_KINDS);
		});
		pi.on("session_shutdown", async () => {
			own?.releaseAll(new Set(LEASE_KINDS));
			heavyCalls.clear();
		});
	};
}

/** A hold that reaches this hand's parent, as the hand is told of it. */
function holdBegun({ hold }: StandingHold): string {
	return `Mesh hold [${shortId(hold)}] (hold) from ${hold.from} at ${clock(hold)}, which reaches the session that started you:\n\n${hold.text}\n\nDo not start what it names until it is over; you will be told when it is. If your task cannot go on without it, stop and say so in your answer. You cannot answer on the mesh; the session that started you can.`;
}

/** Why a heavy command waits, once, while holds stand. */
function heldBack(holds: readonly StandingHold[], work: string): string {
	const each = holds.map(
		({ hold, lease }) =>
			`${hold.from} holds [${shortId(hold)}] since ${clock(hold)}, until ${clock({ at: lease.until })} at the latest: "${hold.text}"`,
	);
	return `Not run yet: this runs heavy work on ${work}, and ${each.join("; and ")}. If a hold names this, leave it and say in your answer that it waits on the hold. Running it again goes ahead anyway.`;
}

export default meshHand();

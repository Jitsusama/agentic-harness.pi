/**
 * Leasing what a session's tools change and run: files it edits, checkouts
 * git rewrites, and heavy work, claimed as each call starts.
 */

import {
	isToolCallEventType,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { sessionCwd } from "../../../lib/core/session/index.ts";
import { whereItRuns } from "../../../lib/internal/priority/send.ts";
import { onJobFinished, onJobTakenUp } from "../../../lib/jobs/host.ts";
import {
	LEASE_EVENT,
	type LeaseEvent,
	leaseEventFrom,
} from "../../../lib/mesh/lease.ts";
import { NOTED } from "../delivery.ts";
import {
	createEditNotes,
	createHeavyCalls,
	takeHeavyCalls,
} from "../leases.ts";
import { delivered, type MeshState } from "./mesh.ts";

/** Claim what this peer's tool calls change and run, over pi's events. */
export function watchHeavyWork(m: MeshState) {
	/** Claim or give up heavy work, saying so when it overlaps another's. */
	const heavy = (event: LeaseEvent) => {
		// A job carried through a reload can end before this runtime has its
		// leases; its release waits for them rather than being lost.
		if (!m.own && "release" in event) {
			m.unowned.push(event);
			return;
		}
		claim(event);
	};
	const claim = (event: LeaseEvent) =>
		void m.leasing
			.heavy(event)
			.then((said) => {
				if (!said) return;
				m.pi.sendMessage(
					{
						customType: NOTED,
						content: said,
						display: true,
						details: delivered([], []),
					},
					{ triggerTurn: false },
				);
			})
			.catch(() => {});

	// The calls a reload carried over from the runtime before this one.
	const heavyCalls = createHeavyCalls(heavy, undefined, takeHeavyCalls());
	const editNotes = createEditNotes();

	// A change claims its file, and a peer reaching for a file another is
	// changing is told who, once, before it goes ahead beside them. A git
	// command that rewrites a checkout claims it the same way, and a heavy
	// command claims its kind of work. Never throws: pi blocks a tool
	// whose handler fails.
	m.pi.on(
		"tool_call",
		async (event, called): Promise<ToolCallEventResult | undefined> => {
			try {
				if (isToolCallEventType("bash", event)) {
					const cwd = sessionCwd(called);
					// The command as it will run: a VM check bound for the
					// builder is no VM work here to lease (send.ts).
					const written = event.input.command;
					const command =
						typeof written === "string"
							? ((await whereItRuns(
									event.toolCallId,
									written,
									cwd,
									called?.signal,
								)) ?? written)
							: written;
					const why =
						typeof command === "string"
							? await m.leasing.rewrite(command, cwd)
							: undefined;
					if (why) return { block: true, reason: why };
					if (m.own && m.peer) heavyCalls.called(event.toolCallId, command);
					return undefined;
				}
				const path =
					isToolCallEventType("edit", event) ||
					isToolCallEventType("write", event)
						? event.input.path
						: undefined;
				if (typeof path !== "string" || path === "") return undefined;
				return editNotes.met(
					event.toolCallId,
					await m.leasing.reach(path, sessionCwd(called)),
				);
			} catch {
				return undefined;
			}
		},
	);

	m.pi.on("tool_result", async (event) => {
		heavyCalls.answered(event.toolCallId, event.content);
		const content = editNotes.noted(event.toolCallId, event.content);
		return content ? { content } : undefined;
	});
	if (m.pi.events) {
		onJobFinished(m.pi.events, ({ toolCallId }) => {
			if (toolCallId === undefined) return;
			// One taken up and ended before the leases came claims nothing.
			const waiting = m.takenUnowned.findIndex(([id]) => id === toolCallId);
			if (waiting >= 0) m.takenUnowned.splice(waiting, 1);
			heavyCalls.finished(toolCallId);
		});
		// A bash call carried here through a host's restart or a move claims
		// its heavy work again, so its end above lets it go: the session it
		// left let go of everything as it ended. Its label is its command's
		// first line, which names its kind of work as the command did.
		onJobTakenUp(m.pi.events, ({ toolCallId, kind, label }) => {
			if (toolCallId === undefined || kind !== "shell") return;
			if (m.own && m.peer) heavyCalls.called(toolCallId, label);
			else m.takenUnowned.push([toolCallId, label]);
		});
	}

	// Heavy work is claimed by whatever places it, over pi's bus.
	m.pi.events?.on(LEASE_EVENT, (data: unknown) => {
		const event = leaseEventFrom(data);
		if (event) heavy(event);
	});

	return { heavy, claim, heavyCalls, editNotes };
}

/** What watchHeavyWork gives the modules after it. */
export type HeavyWork = ReturnType<typeof watchHeavyWork>;

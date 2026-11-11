/**
 * The service's control backend: the order a conversation is held, started,
 * ended and resumed in, over the engine's live ownership and the durable
 * roster. A conversation is held durably before the engine registers it and
 * dropped only after a deliberate close or release commits, so a crash at any
 * step leaves it held for the next start rather than lost.
 */
import type { RosterEntry } from "../../lib/core/session/roster.ts";
import type { ControlBackend } from "./dispatch.ts";
import type { ControlRequest, SessionIdentity } from "./protocol.ts";
import type { AdmitAnother } from "./rollout.ts";
import type { HostRoster } from "./roster.ts";

/** An open request as the wire validated it. */
export type OpenRequest = Extract<ControlRequest, { op: "open" }>;
/** An adopt request as the wire validated it. */
export type AdoptRequest = Extract<ControlRequest, { op: "adopt" }>;

/** A conversation the engine named and created but has not registered. */
export interface Prepared {
	readonly sessionId: string;
	readonly file: string;
	readonly cwd: string;
	/**
	 * The environment the engine derived for the conversation from its
	 * request, held with it so a resume replays it exactly.
	 */
	readonly launch?: Readonly<Record<string, string>>;
}

/**
 * What the engine does for the service. Prepare names the pi id and file
 * without registering; start registers, loads extensions and, for open with
 * first words, resolves once the first durable submit commits; discard
 * undoes only what prepare created; resume re-registers a held conversation,
 * with the launch environment it was held with, and rejects with the reason
 * it can't; abort stops the current run and keeps ownership. watch, called
 * once before anything resumes or opens, hands the engine what to tell the
 * service when a conversation changes inside pi rather than over the wire.
 */
export interface ConversationEngine {
	prepare(request: OpenRequest | AdoptRequest): Promise<Prepared>;
	start(prepared: Prepared, request: OpenRequest | AdoptRequest): Promise<void>;
	discard(prepared: Prepared): Promise<void>;
	resume(entry: RosterEntry): Promise<void>;
	abort(sessionId: string): Promise<void>;
	watch?(events: ConversationEvents): void;
}

/**
 * What the engine tells the service about a conversation pi changed
 * itself. ended: the conversation itself ended (pi's quit, an extension's
 * shutdown, a replacement), after its close committed; never for the
 * host stopping, which parks conversations and keeps them held. became:
 * a held conversation is becoming another under a new id (pi's new, fork
 * or resume), awaited before the engine registers the new id, which it
 * must not register when this rejects.
 */
export interface ConversationEvents {
	ended(sessionId: string, why: string): Promise<void>;
	became(previousId: string, next: Prepared): Promise<void>;
}

/** The engine's live ownership, as SessionHost keeps it. */
export interface LiveHost {
	list(): readonly {
		readonly id: string;
		readonly file: string;
		readonly cwd: string;
		readonly state: SessionIdentity["state"];
		readonly since: string;
	}[];
	holds(id: string): SessionIdentity["state"] | undefined;
	close(id: string, why?: string): Promise<void>;
}

/** A held conversation the engine could not resume, and why. */
export interface Unresumed {
	readonly sessionId: string;
	readonly reason: unknown;
}

/**
 * Answer every control operation in the order that keeps holds durable.
 * With `admitAnother`, an open or adopt while the host already holds a
 * conversation, or is starting one, must pass it first (the rollout gate,
 * rollout.ts); a refusal prepares and holds nothing.
 */
export function hostBackend(options: {
	identity: ControlBackend["identity"];
	host: LiveHost;
	roster: HostRoster;
	engine: ConversationEngine;
	admitAnother?: AdmitAnother;
	now?: () => Date;
}): ControlBackend {
	const { host, roster, engine } = options;
	const now = options.now ?? (() => new Date());
	// Begins still in progress, so two opens at once on an empty host can't
	// both count themselves first.
	let beginning = 0;

	function live(sessionId: string): SessionIdentity {
		const found = host.list().find((held) => held.id === sessionId);
		if (!found) throw new Error(`Conversation is not hosted: ${sessionId}`);
		const { id, file, cwd, state, since } = found;
		return { sessionId: id, file, cwd, state, since };
	}

	// Held but not running, as after a failed resume: listed parked, so a
	// person can see it and close it.
	function stranded(): SessionIdentity[] {
		return roster
			.entries()
			.filter((held) => host.holds(held.sessionId) === undefined)
			.map(({ sessionId, file, cwd, since }) => ({
				sessionId,
				file,
				cwd,
				state: "parked",
				since,
			}));
	}

	function rostered(sessionId: string): boolean {
		return roster.entries().some((held) => held.sessionId === sessionId);
	}

	async function begin(
		request: OpenRequest | AdoptRequest,
	): Promise<SessionIdentity> {
		const another = roster.entries().length + beginning > 0;
		beginning += 1;
		try {
			if (another) await options.admitAnother?.();
			return await started(request);
		} finally {
			beginning -= 1;
		}
	}

	async function started(
		request: OpenRequest | AdoptRequest,
	): Promise<SessionIdentity> {
		const prepared = await engine.prepare(request);
		try {
			await roster.hold({
				sessionId: prepared.sessionId,
				file: prepared.file,
				cwd: prepared.cwd,
				attended: request.attended,
				...(request.quest ? { quest: request.quest } : {}),
				since: now().toISOString(),
				...(prepared.launch ? { launch: prepared.launch } : {}),
			});
		} catch (error) {
			await engine.discard(prepared);
			throw error;
		}
		try {
			await engine.start(prepared, request);
		} catch (error) {
			// Registered and failed: the engine parked it, so it stays held for
			// a person to close. Never registered: nothing owns it, so undo.
			if (host.holds(prepared.sessionId) === undefined) {
				await engine.discard(prepared);
				await roster.drop(prepared.sessionId);
			}
			throw error;
		}
		return live(prepared.sessionId);
	}

	async function end(sessionId: string, why: "closed" | "released") {
		const running = host.holds(sessionId) !== undefined;
		if (!running && !rostered(sessionId))
			throw new Error(`Conversation is not hosted: ${sessionId}`);
		if (running) await host.close(sessionId, why);
		await roster.drop(sessionId);
		return { sessionId };
	}

	return {
		identity: options.identity,
		async execute(request) {
			switch (request.op) {
				case "open":
				case "adopt":
					return begin(request);
				case "list":
					return {
						sessions: [
							...host.list().map((held) => live(held.id)),
							...stranded(),
						],
						host: options.identity,
					};
				case "close":
					return end(request.sessionId, "closed");
				case "release":
					return end(request.sessionId, "released");
				case "abort":
					live(request.sessionId);
					await engine.abort(request.sessionId);
					return { sessionId: request.sessionId };
				case "attach":
					live(request.sessionId);
					return { sessionId: request.sessionId };
			}
		},
	};
}

/**
 * Keep the roster true to what pi did inside a conversation. A conversation
 * that becomes another is held in its place in one write, keeping whether
 * it is attended, its quest and, unless the engine derived a new one, its
 * launch environment; one that ended is dropped. A drop that fails is
 * reported rather than thrown back into pi, whose conversation has already
 * ended; a replacement that fails rejects, so the engine never runs a
 * conversation nothing holds.
 */
export function conversationEvents(options: {
	roster: HostRoster;
	report: (error: unknown) => void;
	now?: () => Date;
}): ConversationEvents {
	const { roster, report } = options;
	const now = options.now ?? (() => new Date());
	return {
		async ended(sessionId) {
			try {
				await roster.drop(sessionId);
			} catch (error) {
				report(error);
			}
		},
		async became(previousId, next) {
			const previous = roster
				.entries()
				.find((held) => held.sessionId === previousId);
			if (!previous) throw new Error(`Conversation is not held: ${previousId}`);
			const launch = next.launch ?? previous.launch;
			await roster.replace(previousId, {
				sessionId: next.sessionId,
				file: next.file,
				cwd: next.cwd,
				attended: previous.attended,
				...(previous.quest ? { quest: previous.quest } : {}),
				since: now().toISOString(),
				...(launch ? { launch } : {}),
			});
		},
	};
}

/** A held conversation a starting host is about to resume, counted from one. */
export interface Resuming {
	readonly step: "resume";
	readonly number: number;
	readonly of: number;
	readonly sessionId: string;
}

/**
 * Resume every held conversation at start, one at a time in the order
 * they were held. One that can't resume stays held, since only a
 * deliberate close or release may drop a hold, and is reported for a
 * person to close or repair. With `admitAnother`, each after the first
 * that resumed must pass it, so the same one runs alone after every
 * restart and a refused one is parked with the open path's reason.
 * `starting` hears each one before it begins, so whoever waits on the
 * start knows it still moves.
 */
export async function resumeHeld(options: {
	roster: HostRoster;
	engine: ConversationEngine;
	admitAnother?: AdmitAnother;
	starting?: (step: Resuming) => Promise<void>;
}): Promise<{ resumed: string[]; unresumed: Unresumed[] }> {
	const resumed: string[] = [];
	const unresumed: Unresumed[] = [];
	const entries = options.roster.entries();
	for (const [index, entry] of entries.entries()) {
		await options.starting?.({
			step: "resume",
			number: index + 1,
			of: entries.length,
			sessionId: entry.sessionId,
		});
		try {
			if (resumed.length > 0) await options.admitAnother?.();
			await options.engine.resume(entry);
			resumed.push(entry.sessionId);
		} catch (reason) {
			unresumed.push({ sessionId: entry.sessionId, reason });
		}
	}
	return { resumed, unresumed };
}

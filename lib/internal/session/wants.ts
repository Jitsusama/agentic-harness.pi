/**
 * What a session is waiting on its person for, said on the bus.
 *
 * Joel works across many windows, and a session that needed him sat
 * waiting in whichever one he was not looking at: an approval panel
 * open, a question at the end of a run, an away run ended `Blocked:`.
 * The desktop's launcher lists sessions from the mesh's presence files,
 * so each want is said here as it starts and as it ends, and the mesh
 * writes the one standing longest into the session's presence for the
 * launcher to mark and notice.
 *
 * Three kinds, since an ask and an approval can stand at once and are
 * answered apart:
 *
 * - question: the session asked something and is waiting for the answer.
 * - approval: a gate is waiting for a yes or no, or calls were held for
 *   the person's return while they were away.
 * - blocked: an away run ended on something only the person can do.
 *
 * A want is said when it starts, when what it says changes, and when it
 * ends. Raising one already standing keeps when it started, so "since"
 * means how long the person has been waited on.
 *
 * A question an open ask waits on carries its choices, so a launcher can
 * show them and let the person answer where they are (KP0L6A, 12
 * November). An answer given there reaches the panel that raised the
 * want by the want's id, through {@link Wants.answer}, and the panel
 * takes it as if it were typed.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { sessionCell } from "../../core/session/index.ts";

/** Said on the bus when a want starts, changes or ends. */
export const SESSION_WANTS = "session:wants:v1";

/**
 * What a session can be waiting on its person for: an answer, an
 * approval, or an unattended run that ended blocked. Something only he
 * can do while the session carries on, said with mesh_wait, is no want:
 * the launcher's Needs You reads it from its own file, and the session
 * is still free to answer its peers.
 */
export type WantKind = "question" | "approval" | "blocked";

/** What `SESSION_WANTS` carries: a want standing, or one kind ended. */
export type WantEvent =
	| {
			readonly kind: WantKind;
			/** When it started, as an ISO time. */
			readonly since: string;
			/** One short line saying what is wanted. */
			readonly said: string;
			/** The choices it can be answered with, when it is an ask. */
			readonly ask?: WantAsk;
	  }
	| { readonly kind: WantKind; readonly said: null };

/** One answer an ask offers. */
export interface WantChoice {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

/** The choices an ask offers, as the ask tool has them. */
export interface WantAsk {
	readonly choices: readonly WantChoice[];
	/** The value the asker recommends, when it names one. */
	readonly recommended?: string;
	/** Whether an answer in the person's own words is taken. */
	readonly allowOther?: boolean;
}

/** An answer given away from the panel: one of its choices, or words. */
export type GivenAnswer =
	| { readonly value: string }
	| { readonly other: string };

/** An ask's choices read from outside, or nothing when they are not. */
export function askFrom(value: unknown): WantAsk | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { choices, recommended, allowOther } = value as Record<string, unknown>;
	if (!Array.isArray(choices)) return undefined;
	const read: WantChoice[] = [];
	for (const one of choices) {
		if (typeof one !== "object" || one === null) return undefined;
		const {
			value: chosen,
			label,
			description,
		} = one as Record<string, unknown>;
		if (typeof chosen !== "string" || typeof label !== "string") {
			return undefined;
		}
		read.push({
			value: chosen,
			label,
			...(typeof description === "string" ? { description } : {}),
		});
	}
	return {
		choices: read,
		...(typeof recommended === "string" ? { recommended } : {}),
		...(typeof allowOther === "boolean" ? { allowOther } : {}),
	};
}

/** An answer given away from a panel, read from outside. */
export function givenFrom(value: unknown): GivenAnswer | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { value: chosen, other } = value as Record<string, unknown>;
	if (typeof chosen === "string") return { value: chosen };
	if (typeof other === "string") return { other };
	return undefined;
}

/** The id a want of this kind, begun then, goes by. */
export function wantId(kind: WantKind, since: string): string {
	return `${kind}@${since}`;
}

const KINDS: ReadonlySet<string> = new Set(["question", "approval", "blocked"]);

/** Whether a payload is a want, as this version says one. */
function isWant(data: unknown): data is WantEvent {
	if (typeof data !== "object" || data === null) return false;
	const { kind, since, said } = data as Record<string, unknown>;
	if (typeof kind !== "string" || !KINDS.has(kind)) return false;
	if (said === null) return true;
	return typeof said === "string" && typeof since === "string";
}

/** Hear every want start, change and end. Returns a disposer. */
export function onWants(
	bus: EventBus,
	listener: (want: WantEvent) => void,
): () => void {
	return bus.on(SESSION_WANTS, (data) => {
		if (isWant(data)) listener(data);
	});
}

/** The longest a want's line is said at, so a launcher can show it whole. */
export const SAID_CHARS = 120;

/** One line, no longer than {@link SAID_CHARS}. */
export function oneLine(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= SAID_CHARS
		? line
		: `${line.slice(0, SAID_CHARS - 1).trimEnd()}\u2026`;
}

/** The wants a session has standing, said on whichever bus is bound. */
export interface Wants {
	/**
	 * Raise a want of this kind, or change what one already standing says.
	 * The answer lowers this raising; the want ends once every raising of
	 * its kind is lowered, or when {@link Wants.end} ends it.
	 */
	raise(kind: WantKind, said: string, now?: Date, ask?: AskedWant): () => void;
	/** End every raising of this kind, as the person's answer does. */
	end(kind: WantKind): void;
	/**
	 * Give the want `id` names an answer from away from its panel,
	 * answering whether a panel took it. Nothing takes one for a want
	 * that has ended, that is no ask, or whose ask offers no such answer.
	 */
	answer?(id: string, given: GivenAnswer): boolean;
	/** Say the wants on this bus from now on, and say those standing on it. */
	bind(bus: EventBus): void;
	/** Stop saying anything on this bus, if it is the one bound. */
	unbind(bus: EventBus): void;
}

/** An ask's choices, and what takes an answer given away from it. */
export interface AskedWant extends WantAsk {
	take(given: GivenAnswer): void;
}

interface Standing {
	readonly since: string;
	said: string;
	raised: number;
	ask?: AskedWant;
}

/** The ask's choices as said on the bus, without what takes an answer. */
function choicesOf(ask: AskedWant): WantAsk {
	return {
		choices: ask.choices.map((one) => ({
			value: one.value,
			label: one.label,
			...(one.description === undefined
				? {}
				: { description: one.description }),
		})),
		...(ask.recommended === undefined ? {} : { recommended: ask.recommended }),
		...(ask.allowOther === undefined ? {} : { allowOther: ask.allowOther }),
	};
}

/** Whether `ask` takes `given`: a choice it offers, or words it allows. */
function offers(ask: WantAsk, given: GivenAnswer): boolean {
	if ("value" in given) {
		return ask.choices.some((one) => one.value === given.value);
	}
	return ask.allowOther === true && given.other.trim() !== "";
}

/**
 * A fresh set of wants, bound to nothing. Sessions use the one
 * {@link sessionWants} keeps; this is for tests.
 */
export function createWants(): Wants {
	const standing = new Map<WantKind, Standing>();
	let bus: EventBus | undefined;
	const say = (event: WantEvent) => bus?.emit(SESSION_WANTS, event);
	const sayStanding = (kind: WantKind, want: Standing) =>
		say({
			kind,
			since: want.since,
			said: want.said,
			...(want.ask ? { ask: choicesOf(want.ask) } : {}),
		});
	const end = (kind: WantKind) => {
		if (standing.delete(kind)) say({ kind, said: null });
	};
	return {
		raise(kind, said, now = new Date(), ask = undefined) {
			const line = oneLine(said);
			const current = standing.get(kind);
			const want: Standing = current ?? {
				since: now.toISOString(),
				said: line,
				raised: 0,
			};
			want.raised += 1;
			// The newest ask is the one an answer from away goes to.
			const asks = ask !== undefined && ask !== want.ask;
			if (current === undefined || current.said !== line || asks) {
				want.said = line;
				if (ask) want.ask = ask;
				standing.set(kind, want);
				sayStanding(kind, want);
			}
			let lowered = false;
			return () => {
				if (lowered) return;
				lowered = true;
				// A want ended meanwhile, and perhaps raised afresh, is not this one.
				if (standing.get(kind) !== want) return;
				want.raised -= 1;
				if (want.raised <= 0) {
					end(kind);
					return;
				}
				// Its panel is gone, so its choices answer nothing any more.
				if (ask && want.ask === ask) {
					delete want.ask;
					sayStanding(kind, want);
				}
			};
		},
		end,
		answer(id, given) {
			for (const [kind, want] of standing) {
				if (wantId(kind, want.since) !== id) continue;
				if (!(want.ask && offers(want.ask, given))) return false;
				want.ask.take(given);
				return true;
			}
			return false;
		},
		bind(next) {
			bus = next;
			for (const [kind, want] of standing) sayStanding(kind, want);
		},
		unbind(gone) {
			if (bus === gone) bus = undefined;
		},
	};
}

/**
 * The session's wants. Kept in a session cell, which on plain pi is the
 * global symbol itself, because a reload loads this module afresh while
 * a panel raised by the old copy may still be open: the one holder
 * outlives the copies, so what it holds is said again on the bus the
 * reloaded session binds. On a host each conversation has its own.
 */
const HELD = "agentic-harness.session-wants";
/** Each owner's standing wants, kept the same way. */
const OWNERS = "agentic-harness.session-wants-owners";
/** How many things show the wants, kept the same way. */
const SHOWN = "agentic-harness.session-wants-shown";

/** What the session's cell `name` holds, made on first asking. */
function held<T>(name: string, create: () => T): T {
	const cell = sessionCell<T>(name);
	const there = cell.get();
	if (there !== undefined) return there;
	const made = create();
	cell.set(made);
	return made;
}

/** The session's wants, made on first asking. */
export function sessionWants(): Wants {
	return held(HELD, createWants);
}

/**
 * Wants a caller keeps one of per kind, saying what each is now, for
 * those that are a standing state rather than one wait each: calls held
 * while the person is away, a run that ended blocked or asking.
 */
export interface OwnWants {
	/** Say this kind is wanted, keeping when it was first wanted. */
	say(kind: WantKind, said: string, now?: Date): void;
	/** This caller no longer wants this kind. */
	settle(kind: WantKind): void;
}

/**
 * One owner's wants in this process, the same ones however often its
 * extension is reloaded: a session reloads itself when it is still,
 * which is just when a blocked run or a question stands, and the copy
 * loaded after must be able to settle what the one before said.
 */
export function ownWants(owner: string): OwnWants {
	const owners = held(OWNERS, () => new Map<string, OwnWants>());
	let own = owners.get(owner);
	if (!own) {
		own = createOwnWants(sessionWants());
		owners.set(owner, own);
	}
	return own;
}

/**
 * Say that this process's wants are shown to the person, as the mesh
 * shows them in the session's presence for the launcher, until the
 * answer is called. While they are, a want is the one voice for what it
 * waits on: the launcher already posts a notice for each, so a desktop
 * notification of the same thing reached Joel twice, and one the
 * launcher never withdrew. Kept in a cell, like the wants, so a
 * reload's old copy and new one count the same showing. The answer
 * hides from the session that showed, wherever it is called, and only
 * from the count it raised: once the wants are forgotten, a showing
 * from before can't hide one made since.
 */
export function showWants(): () => void {
	const shown = showing();
	shown.count += 1;
	let hidden = false;
	return () => {
		if (hidden) return;
		hidden = true;
		shown.count = Math.max(0, shown.count - 1);
	};
}

/** How many things show a session's wants, as one record its answers lower. */
interface Shown {
	count: number;
}

/**
 * The session's showing record. A copy loaded before this one kept a bare
 * count under the same name, which a reload across them finds and carries
 * into the record.
 */
function showing(): Shown {
	const cell = sessionCell<Shown | number>(SHOWN);
	const there = cell.get();
	if (typeof there === "object") return there;
	const made = { count: typeof there === "number" ? there : 0 };
	cell.set(made);
	return made;
}

/** Whether something shows the session's wants to the person. */
export function wantsShown(): boolean {
	return showing().count > 0;
}

/** Forget the session's wants, their owners and their showing. For tests. */
export function forgetWants(): void {
	for (const name of [HELD, OWNERS, SHOWN]) sessionCell(name).clear();
}

/** One raising per kind on these wants, replaced as what it says changes. */
export function createOwnWants(wants: Wants): OwnWants {
	const lowers = new Map<WantKind, () => void>();
	return {
		say(kind, said, now) {
			// Raised anew before the old is lowered, so the want never ends
			// between the two and keeps the time it started.
			const lower = wants.raise(kind, said, now);
			lowers.get(kind)?.();
			lowers.set(kind, lower);
		},
		settle(kind) {
			lowers.get(kind)?.();
			lowers.delete(kind);
		},
	};
}

/**
 * How long a panel stands unanswered before it counts as a want. A panel
 * the person answers at a glance, as they do one their own command
 * opened, then says nothing to a launcher watching for wants.
 */
export const WANT_AFTER_MS = 5_000;

/**
 * Wait for an answer, raising a want of this kind if it has not come
 * within {@link WANT_AFTER_MS}. The want dates from when the wait began,
 * and is lowered however the wait ends. An `ask` says its choices with
 * the want, and takes an answer given away from the panel.
 */
export async function waitedOn<T>(
	kind: WantKind,
	said: string,
	answer: Promise<T>,
	wants: Wants = sessionWants(),
	afterMs: number = WANT_AFTER_MS,
	ask: AskedWant | undefined = undefined,
): Promise<T> {
	const began = new Date();
	let lower: (() => void) | undefined;
	const timer = setTimeout(() => {
		lower = wants.raise(kind, said, began, ask);
	}, afterMs);
	timer.unref?.();
	try {
		return await answer;
	} finally {
		clearTimeout(timer);
		lower?.();
	}
}

/**
 * Give the session's want `id` an answer from away from its panel,
 * answering whether a panel took it. Wants a copy from before answers
 * existed still hold after a reload take none.
 */
export function answerWant(
	id: string,
	given: GivenAnswer,
	wants: Wants = sessionWants(),
): boolean {
	return wants.answer?.(id, given) ?? false;
}

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
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";

/** Said on the bus when a want starts, changes or ends. */
export const SESSION_WANTS = "session:wants:v1";

/** What a session can be waiting on its person for. */
export type WantKind = "question" | "approval" | "blocked";

/** What `SESSION_WANTS` carries: a want standing, or one kind ended. */
export type WantEvent =
	| {
			readonly kind: WantKind;
			/** When it started, as an ISO time. */
			readonly since: string;
			/** One short line saying what is wanted. */
			readonly said: string;
	  }
	| { readonly kind: WantKind; readonly said: null };

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
	raise(kind: WantKind, said: string, now?: Date): () => void;
	/** End every raising of this kind, as the person's answer does. */
	end(kind: WantKind): void;
	/** Say the wants on this bus from now on, and say those standing on it. */
	bind(bus: EventBus): void;
	/** Stop saying anything on this bus, if it is the one bound. */
	unbind(bus: EventBus): void;
}

interface Standing {
	readonly since: string;
	said: string;
	raised: number;
}

/**
 * A fresh set of wants, bound to nothing. Sessions use the one
 * {@link sessionWants} keeps; this is for tests.
 */
export function createWants(): Wants {
	const standing = new Map<WantKind, Standing>();
	let bus: EventBus | undefined;
	const say = (event: WantEvent) => bus?.emit(SESSION_WANTS, event);
	const end = (kind: WantKind) => {
		if (standing.delete(kind)) say({ kind, said: null });
	};
	return {
		raise(kind, said, now = new Date()) {
			const line = oneLine(said);
			const current = standing.get(kind);
			const want = current ?? {
				since: now.toISOString(),
				said: line,
				raised: 0,
			};
			want.raised += 1;
			if (current === undefined || current.said !== line) {
				want.said = line;
				standing.set(kind, want);
				say({ kind, since: want.since, said: line });
			}
			let lowered = false;
			return () => {
				if (lowered) return;
				lowered = true;
				// A want ended meanwhile, and perhaps raised afresh, is not this one.
				if (standing.get(kind) !== want) return;
				want.raised -= 1;
				if (want.raised <= 0) end(kind);
			};
		},
		end,
		bind(next) {
			bus = next;
			for (const [kind, want] of standing) {
				say({ kind, since: want.since, said: want.said });
			}
		},
		unbind(gone) {
			if (bus === gone) bus = undefined;
		},
	};
}

/**
 * This process's wants. Kept on `globalThis` because a reload loads this
 * module afresh while a panel raised by the old copy may still be open:
 * the one holder outlives the copies, so what it holds is said again on
 * the bus the reloaded session binds.
 */
const HELD = Symbol.for("agentic-harness.session-wants");

type Holder = { [HELD]?: Wants };

/** This process's wants, made on first asking. */
export function sessionWants(): Wants {
	const holder = globalThis as Holder;
	holder[HELD] ??= createWants();
	return holder[HELD];
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
	const holder = globalThis as OwnersHolder;
	holder[OWNERS] ??= new Map();
	const owners = holder[OWNERS];
	let own = owners.get(owner);
	if (!own) {
		own = createOwnWants(sessionWants());
		owners.set(owner, own);
	}
	return own;
}

const OWNERS = Symbol.for("agentic-harness.session-wants-owners");

type OwnersHolder = { [OWNERS]?: Map<string, OwnWants> };

/** Forget this process's wants and their owners. For tests. */
export function forgetWants(): void {
	delete (globalThis as Holder)[HELD];
	delete (globalThis as OwnersHolder)[OWNERS];
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
 * and is lowered however the wait ends.
 */
export async function waitedOn<T>(
	kind: WantKind,
	said: string,
	answer: Promise<T>,
	wants: Wants = sessionWants(),
	afterMs: number = WANT_AFTER_MS,
): Promise<T> {
	const began = new Date();
	let lower: (() => void) | undefined;
	const timer = setTimeout(() => {
		lower = wants.raise(kind, said, began);
	}, afterMs);
	timer.unref?.();
	try {
		return await answer;
	} finally {
		clearTimeout(timer);
		lower?.();
	}
}

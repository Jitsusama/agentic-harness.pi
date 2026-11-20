/**
 * The host side of the budget contract: the providers registered over
 * the bus, asking them in turn what a budget's name means, and asking
 * them all at once which budget a folder's work draws on.
 *
 * Kept apart from the extension that hosts it so the chain can be
 * tested without pi, and so the contract's two halves sit together.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
	BUDGET_READY,
	BUDGET_REGISTER_PROVIDER,
	BUDGET_REQUEST,
	type BudgetAnswer,
	type BudgetHostApi,
	type BudgetProvider,
	type Classify,
	isBudgetName,
	isBudgetProvider,
	type WorkJudgement,
	type WorkToBudget,
} from "./provider.ts";

/** What asking the providers about one name came to. */
export type BudgetDrawing =
	| {
			readonly kind: "drawn";
			readonly provider: string;
			readonly env: Readonly<Record<string, string>>;
			readonly label: string;
	  }
	| {
			readonly kind: "unavailable";
			readonly provider: string;
			readonly reason: string;
	  }
	| {
			/** No provider knew the name; these were asked. */
			readonly kind: "unknown";
			readonly asked: readonly string[];
	  };

/** A drawing that drew. */
type Drawn = Extract<BudgetDrawing, { readonly kind: "drawn" }>;

/** The host: its registry, and the one question it asks of it. */
export interface BudgetHost extends BudgetHostApi {
	/**
	 * Ask each provider, lowest precedence first, what `name` means. One
	 * that misses the deadline is still waited for, out of the caller's
	 * way, and meanwhile the name's last drawing stands in for it, when
	 * there is one: a busy host measures itself, not the provider, so a
	 * late answer is no answer that the budget can't be drawn on.
	 */
	draw(name: string): Promise<BudgetDrawing>;
	/** Be told each time a provider registers, as a late one may answer. */
	onRegistered(listener: () => void): void;
	/**
	 * Be told the name a draw that missed its deadline has drawn on since,
	 * so what fell to the default can draw on it now rather than at its
	 * next retry.
	 */
	onDrawnLate(listener: (name: string) => void): void;
	/**
	 * The budget work in `folder` draws on, from the first provider,
	 * lowest precedence first, that names one, and which it was. Every
	 * provider is asked at once and given the one deadline, so a create
	 * waits at most that long however many there are. A provider that
	 * fails, answers late, or names `none` or something that can't be a
	 * budget is passed over: a folder only ever names a budget to draw
	 * on, and opting out stays the person's word on a quest. One that
	 * fails or answers late is told to the host's `troubled`, since a
	 * quest it leaves unnamed draws on the person's own key.
	 */
	budgetFor(folder: string): Promise<FolderBudget | undefined>;
	/**
	 * Which budget `work` draws on, as the first provider, lowest
	 * precedence first, that judges it surely says, else the first that
	 * judges it at all, and which it was. Asked at once under the one
	 * deadline, as `budgetFor` is, though a longer one, since a
	 * judgement waits on a model. One that fails, answers late or names
	 * something that can't be a budget is passed over. The classifier
	 * each is handed aborts at the deadline, or with `signal`.
	 */
	budgetForWork(
		work: WorkToBudget,
		classify: Classify,
		signal?: AbortSignal,
	): Promise<WorkBudget | undefined>;
}

/** A provider's judgement of which budget some work draws on. */
export interface WorkBudget extends WorkJudgement {
	readonly provider: string;
}

/** The budget a provider says a folder's work draws on. */
export interface FolderBudget {
	readonly name: string;
	readonly provider: string;
}

/**
 * What a provider asked about a folder couldn't say: which, the
 * folder, and why.
 */
export interface FolderTrouble {
	readonly provider: string;
	readonly folder: string;
	readonly why: string;
}

/**
 * Host budget providers on `bus`: take their registrations, answer a
 * request for the host, and announce it once now. A provider that
 * fails or answers late when asked about a folder is told to
 * `troubled`.
 */
export function hostBudgets(
	bus: Pick<EventBus, "emit" | "on">,
	deadlineMs: number = BUDGET_ANSWER_DEADLINE_MS,
	troubled: (trouble: FolderTrouble) => void = () => undefined,
	judgeMs: number = BUDGET_JUDGEMENT_DEADLINE_MS,
	lateMs: number = BUDGET_LATE_ANSWER_MS,
): BudgetHost {
	const providers = new Map<string, BudgetProvider>();
	const listeners: (() => void)[] = [];
	const lateListeners: ((name: string) => void)[] = [];
	const ordered = () =>
		[...providers.values()].sort((a, b) => a.precedence - b.precedence);
	// Each provider's answer still on its way, by provider and name, so
	// a draw asked again while one is late waits on it rather than
	// piling another on a host already too busy to answer the first.
	// Each is kept with when it was asked, since a draw that joins it
	// waits only what is left of its deadline.
	const coming = new Map<
		string,
		{ answer: Promise<BudgetAnswer | typeof LATE>; askedAt: number }
	>();
	// Counts the providers registered, so what an ask of a replaced one
	// answers lays nothing and tells nobody.
	let era = 0;
	// Each name's last drawing, which stands in for a provider that is
	// late, and only for one that is: any answer in time replaces it.
	const lastDrawn = new Map<string, Drawn>();
	// The names a draw that missed its deadline is still waiting on, by
	// the provider that was late, with whether any such draw went without
	// and the drawing that stood in for the rest. The late answer is told
	// only where it differs from what a draw was given: one the last
	// drawing stood in for, answered the same, already has it, and telling
	// it would only ask again of a busy host.
	const waiting = new Map<
		string,
		{ without: boolean; stood: Drawn | undefined }
	>();
	// Each name's late answer that was told, and when, for the draw the
	// telling brings: it takes this rather than asking the busy provider
	// again, whose next answer, a fresh token each time, would be told in
	// turn, and so on for the whole session.
	const told = new Map<string, { drawing: BudgetDrawing; at: number }>();
	const answerOf = (provider: BudgetProvider, name: string) => {
		const key = `${provider.id}\0${name}`;
		let ask = coming.get(key);
		if (!ask) {
			const answer = askOne(provider, name, lateMs);
			const made = { answer, askedAt: Date.now() };
			coming.set(key, made);
			void answer.finally(() => {
				if (coming.get(key) === made) coming.delete(key);
			});
			ask = made;
		}
		return ask;
	};
	const drawWithin = async (
		name: string,
		withinMs: number,
		from?: string,
		long = false,
	): Promise<BudgetDrawing | { readonly lateOf: string }> => {
		const drawnIn = era;
		const stands = (drawing: BudgetDrawing | undefined) => {
			if (drawnIn !== era) return;
			if (drawing?.kind === "drawn") lastDrawn.set(name, drawing);
			else lastDrawn.delete(name);
		};
		const asked: string[] = [];
		const all = ordered();
		const start = Math.max(
			0,
			all.findIndex((provider) => provider.id === from),
		);
		for (const provider of all.slice(start)) {
			asked.push(provider.id);
			const ask = answerOf(provider, name);
			const left = Math.max(0, withinMs - (Date.now() - ask.askedAt));
			const answer = await within(ask.answer, left, long);
			if (answer === LATE) return { lateOf: provider.id };
			if (answer.kind === "unknown") {
				// Its own last drawing can't stand in once it says it has none.
				if (lastDrawn.get(name)?.provider === provider.id) stands(undefined);
				continue;
			}
			const drawing = { ...answer, provider: provider.id };
			stands(drawing);
			return drawing;
		}
		stands(undefined);
		return { kind: "unknown", asked };
	};
	const waitOn = (name: string, lateOf: string, stood: Drawn | undefined) => {
		const key = `${lateOf}\0${name}`;
		const already = waiting.get(key);
		if (already) {
			if (stood) already.stood = stood;
			else already.without = true;
			return;
		}
		const wait = { without: stood === undefined, stood };
		waiting.set(key, wait);
		const waitedIn = era;
		// From the late provider on: those ahead of it answered in time, and
		// its own answer is the one already on its way, so this asks nothing
		// again of it. Its bound ends a stuck one as late, which tells none.
		void drawWithin(name, lateMs, lateOf, true)
			.then((drawing) => {
				if (waitedIn !== era || !("kind" in drawing)) return;
				const gained = wait.without && drawing.kind === "drawn";
				const changed =
					wait.stood !== undefined && !sameDrawing(wait.stood, drawing);
				if (!gained && !changed) return;
				told.set(name, { drawing, at: Date.now() });
				for (const listener of lateListeners) tellLate(listener, name);
			})
			.catch(() => {
				// Nothing here rejects: askOne reads a throw or a malformed answer
				// as unavailable, and tellLate passes over a listener that throws.
				// Kept so that a slip there can't leave a rejection to end pi.
			})
			.finally(() => {
				if (waiting.get(key) === wait) waiting.delete(key);
			});
	};
	const host: BudgetHost = {
		registerProvider(provider) {
			// An ask of the one it replaces answers for that one, not this, so
			// what it answers lays nothing and tells nobody, and a late draw
			// waits on the new one afresh.
			for (const key of coming.keys())
				if (key.startsWith(`${provider.id}\0`)) coming.delete(key);
			era++;
			waiting.clear();
			told.clear();
			providers.set(provider.id, provider);
			for (const listener of listeners) listener();
		},
		listProviders: () => ordered().map((provider) => provider.id),
		onRegistered(listener) {
			listeners.push(listener);
		},
		onDrawnLate(listener) {
			lateListeners.push(listener);
		},
		async draw(name) {
			const late = told.get(name);
			told.delete(name);
			if (late && Date.now() - late.at <= lateMs) return late.drawing;
			const drawing = await drawWithin(name, deadlineMs);
			if ("kind" in drawing) return drawing;
			const stands = lastDrawn.get(name);
			waitOn(name, drawing.lateOf, stands);
			return (
				stands ?? {
					kind: "unavailable",
					provider: drawing.lateOf,
					// The answer names the provider beside its reason, quoted, so
					// the reason leaves it out rather than say it twice, or raw.
					reason: `It didn't answer within ${deadlineMs / MS_PER_SECOND} s.`,
				}
			);
		},
		async budgetFor(folder) {
			const asking = ordered().filter((p) => typeof p.budgetFor === "function");
			// All asked at once, and read in order, so the answer comes as
			// soon as every provider before the first to name one has said.
			// One that fails or answers late is told to troubled only when
			// it ranks above the answer, since only then could it have
			// changed it; one below is passed over without a word.
			const answers = asking.map((provider) =>
				askFolder(provider, folder, deadlineMs),
			);
			for (const [at, provider] of asking.entries()) {
				const said = await answers[at];
				if (typeof said === "string")
					return { name: said, provider: provider.id };
				if (said)
					tell(troubled, { provider: provider.id, folder, why: said.why });
			}
			return undefined;
		},
		async budgetForWork(work, classify, signal) {
			const asking = ordered().filter(
				(p) => typeof p.budgetForWork === "function",
			);
			// Aborted once the answer is settled, so the providers after a
			// sure one stop their classifier calls rather than paying on.
			const settled = new AbortController();
			const asked = signal
				? AbortSignal.any([signal, settled.signal])
				: settled.signal;
			const judged = asking.map((provider) =>
				askWork(provider, work, classify, judgeMs, asked),
			);
			try {
				// A sure answer from any wins over an unsure one from a
				// provider before it, which named nothing and only guessed.
				let guess: WorkBudget | undefined;
				let cut = false;
				for (const [at, provider] of asking.entries()) {
					const judgement = await judged[at];
					if (judgement === CUT_OFF) cut = true;
					if (!judgement || judgement === CUT_OFF) continue;
					const said = { ...judgement, provider: provider.id };
					if (said.sure) return said;
					guess ??= said;
				}
				// A guess is the answer only when no provider that might have
				// been sure was stopped first: a judgement cut short is none,
				// and is asked again, rather than an unsure one journaled.
				return cut ? undefined : guess;
			} finally {
				settled.abort();
			}
		},
	};
	bus.on(BUDGET_REGISTER_PROVIDER, (data: unknown) => {
		if (isBudgetProvider(data)) host.registerProvider(data);
	});
	const api: BudgetHostApi = {
		registerProvider: host.registerProvider,
		listProviders: host.listProviders,
	};
	bus.on(BUDGET_REQUEST, () => bus.emit(BUDGET_READY, api));
	bus.emit(BUDGET_READY, api);
	return host;
}

/**
 * How long a provider may take to answer. Session start and quest
 * actions wait on the answer, so one stuck on a password manager's
 * prompt must not hold them.
 */
export const BUDGET_ANSWER_DEADLINE_MS = 5_000;

/**
 * How long a provider that missed the deadline is still waited for, out
 * of the caller's way, before it counts as stuck: long past what a busy
 * host takes to read a file, and well short of a session's life.
 */
export const BUDGET_LATE_ANSWER_MS = 120_000;

const MS_PER_SECOND = 1000;

/**
 * How long a provider may take to judge work. A classifier answers in
 * a few seconds and a create waits on it only once, when nothing else
 * names its budget; past this, the quest is made unjudged.
 */
export const BUDGET_JUDGEMENT_DEADLINE_MS = 20_000;

/** The most of a provider's why a line about it carries. */
const LONGEST_WHY = 300;

/** What a provider stopped by the deadline or the caller said. */
const CUT_OFF = "cut off";

/**
 * One provider's judgement of `work`, undefined when it can't say,
 * fails or names no budget's name, or `CUT_OFF` when the deadline or
 * the caller stopped it first. Its why is made one line, since every
 * line about it quotes it.
 */
async function askWork(
	provider: BudgetProvider,
	work: WorkToBudget,
	classify: Classify,
	deadlineMs: number,
	signal: AbortSignal | undefined,
): Promise<WorkJudgement | typeof CUT_OFF | undefined> {
	if (signal?.aborted) return CUT_OFF;
	// Aborted at the deadline, so a classifier call nobody waits on any
	// more stops rather than running, and costing, on.
	const cutoff = new AbortController();
	const stop = signal
		? AbortSignal.any([signal, cutoff.signal])
		: cutoff.signal;
	const bounded: Classify = (context, own) =>
		classify(context, own ? AbortSignal.any([own, stop]) : stop);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let end: (() => void) | undefined;
	const late = new Promise<undefined>((resolve) => {
		end = () => {
			cutoff.abort();
			resolve(undefined);
		};
		timer = setTimeout(end, deadlineMs);
		signal?.addEventListener("abort", end, { once: true });
	});
	try {
		const judged = await Promise.race([
			provider.budgetForWork?.(work, bounded),
			late,
		]);
		if (stop.aborted) return CUT_OFF;
		if (
			typeof judged !== "object" ||
			judged === null ||
			typeof judged.name !== "string" ||
			!isBudgetName(judged.name)
		) {
			return undefined;
		}
		const why =
			typeof judged.why === "string"
				? judged.why.replace(/\s+/g, " ").trim().slice(0, LONGEST_WHY)
				: "";
		return { name: judged.name, why, sure: judged.sure === true };
	} catch {
		// A provider that can't judge is passed over, as one that won't;
		// one that failed because it was stopped was cut off, not wrong.
		return stop.aborted ? CUT_OFF : undefined;
	} finally {
		clearTimeout(timer);
		// One sweep asks many times under one signal, so each ask takes
		// its listener away again.
		if (end) signal?.removeEventListener("abort", end);
	}
}

/**
 * The word a quest opts out of budgets with, which a folder's answer
 * never stands for (lib/internal/quest/fields/budget.ts's NO_BUDGET,
 * which lib/budget doesn't import, since it sits below quests).
 */
const FOLDER_OPTS_OUT = "none";

/**
 * Tells `troubled` of a folder ask's trouble. A sink that throws is
 * passed over: a read nobody awaits once an earlier provider answered
 * must not leave a rejection behind.
 */
function tell(
	troubled: (trouble: FolderTrouble) => void,
	trouble: FolderTrouble,
): void {
	try {
		troubled(trouble);
	} catch {
		// The trouble goes unsaid; the budget the folder draws on stands.
	}
}

/** What a folder's ask races its answer against. */
const LATE: unique symbol = Symbol("late");

/**
 * The budget one provider says `folder` draws on; undefined when it
 * names none, `none` or no budget's name; or why it couldn't say, when
 * it fails or doesn't answer within the deadline: a create waits on
 * this, so it can't wait for long.
 */
async function askFolder(
	provider: BudgetProvider,
	folder: string,
	deadlineMs: number,
): Promise<string | { readonly why: string } | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<typeof LATE>((resolve) => {
		timer = setTimeout(() => resolve(LATE), deadlineMs);
	});
	try {
		const name = await Promise.race([provider.budgetFor?.(folder), late]);
		if (name === LATE) {
			return {
				why: `it didn't answer within ${deadlineMs / MS_PER_SECOND} s`,
			};
		}
		return typeof name === "string" &&
			isBudgetName(name) &&
			name !== FOLDER_OPTS_OUT
			? name
			: undefined;
	} catch (error) {
		// Passed over, as one that names none, and said why.
		return { why: `it failed: ${whatFailed(error)}` };
	} finally {
		clearTimeout(timer);
	}
}

/** `answer`, or `LATE` when it hasn't come within `withinMs`. */
async function within<T>(
	answer: Promise<T>,
	withinMs: number,
	long = false,
): Promise<T | typeof LATE> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<typeof LATE>((resolve) => {
		timer = setTimeout(() => resolve(LATE), withinMs);
		// The late wait runs long, so it mustn't keep a process up that has
		// nothing else to do; a caller's own deadline keeps it, as before.
		if (long) timer.unref();
	});
	try {
		return await Promise.race([answer, late]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Tells `listener` a late draw drew on `name`. One that throws is passed
 * over, since nothing awaits the late draw to take its rejection.
 */
function tellLate(listener: (name: string) => void, name: string): void {
	try {
		listener(name);
	} catch {
		// That listener misses the late drawing; its next draw has it.
	}
}

/**
 * One provider's answer, with a rejection read as unavailable; or `LATE`
 * when none comes within `lateMs`, so a draw that joins the ask near its
 * end reads it as late, as it is, rather than as an answer in time.
 */
async function askOne(
	provider: BudgetProvider,
	name: string,
	lateMs: number,
): Promise<BudgetAnswer | typeof LATE> {
	try {
		const said = await within(
			Promise.resolve(provider.resolve(name)),
			lateMs,
			true,
		);
		if (said === LATE || isAnswer(said)) return said;
		return { kind: "unavailable", reason: NO_ANSWER };
	} catch (error) {
		return { kind: "unavailable" as const, reason: whatFailed(error) };
	}
}

/** What a provider whose answer isn't one is said to have done. */
const NO_ANSWER = "It answered with something that isn't a budget's answer.";

/**
 * Whether `said` has the shape the host reads before anything else does:
 * a kind it knows, and for a drawing, its variables. A reason that isn't
 * words is said as none further on, so it passes here.
 */
function isAnswer(said: unknown): said is BudgetAnswer {
	if (typeof said !== "object" || said === null || !("kind" in said))
		return false;
	if (said.kind === "unknown" || said.kind === "unavailable") return true;
	return (
		said.kind === "drawn" &&
		"env" in said &&
		typeof said.env === "object" &&
		said.env !== null
	);
}

/** Whether `drawing` is `stood`, by what a call draws on. */
function sameDrawing(stood: Drawn, drawing: BudgetDrawing): boolean {
	if (drawing.kind !== "drawn") return false;
	if (drawing.provider !== stood.provider || drawing.label !== stood.label)
		return false;
	const before = Object.entries(stood.env);
	return (
		before.length === Object.keys(drawing.env).length &&
		before.every(([key, value]) => drawing.env[key] === value)
	);
}

/**
 * What a provider's failure says, whatever it threw: a catch that
 * threw in turn would leave the rejection an unawaited ask must not.
 */
function whatFailed(error: unknown): string {
	try {
		return error instanceof Error ? String(error.message) : String(error);
	} catch {
		// A thrown thing whose words throw in turn still failed; say only that.
		return "something that can't be said";
	}
}

/**
 * Whether the person is away, and what waited for them while they were.
 *
 * Being away is a mode rather than a convention the model has to
 * remember. While it is on, nothing waits on a person: an approval that
 * would have opened a panel is held instead, a question is answered with
 * the asker's recommendation, and both are kept here until the person is
 * back.
 *
 * Nothing here approves anything. A held call is a record of what the
 * model wanted to do; on the person's return it is listed for them, and
 * the model makes again the calls still wanted, each of which asks in
 * its own panel. So no approval can outlive the moment it was given, and
 * a call is never let through on the strength of an earlier one.
 *
 * State lives on `globalThis` under a `Symbol.for` key, like the guard
 * policy, so every extension and every loaded copy of this module reads
 * the same answer.
 */

import { createHash } from "node:crypto";

/** A call a gate held instead of asking. */
export interface HeldCall {
	/** Numbered from 1 within an absence, as the model is told. */
	readonly id: number;
	readonly guard: string;
	/** What the panel would have been titled. */
	readonly title: string;
	/** What the panel would have shown, as markdown. */
	readonly body?: string;
	/** Guard, title and body, hashed: the same call held twice is one hold. */
	readonly fingerprint: string;
	/** ISO timestamp. */
	readonly at: string;
}

/** A question answered without the person. */
export interface Decision {
	readonly question: string;
	readonly answer: string;
	/** Whose answer it was: the asker's recommendation, or left to the model. */
	readonly by: "recommendation" | "model";
	readonly at: string;
}

/** Everything about an absence, as plain data that can be stored. */
export interface AwaySnapshot {
	/** ISO timestamp the absence began, or undefined when present. */
	readonly since?: string;
	/** What the person asked to have done while away, in their words. */
	readonly goal?: string;
	readonly held: readonly HeldCall[];
	readonly decided: readonly Decision[];
}

/** What waited, handed over when the person is back. */
export interface Return {
	readonly since: string;
	readonly goal?: string;
	readonly held: readonly HeldCall[];
	readonly decided: readonly Decision[];
}

/** Where the work stands, as whoever tracks plans says. */
export interface PlanProgress {
	/** The document the progress is for, e.g. a plan id. */
	readonly document: string;
	readonly done: number;
	readonly total: number;
	/** The first item not yet done. */
	readonly next?: string;
}

type Listener = (snapshot: AwaySnapshot) => void;

interface AwayState {
	since?: string;
	goal?: string;
	held: HeldCall[];
	decided: Decision[];
	listeners: Set<Listener>;
	progress?: () => PlanProgress | undefined;
	/** The run under way was stopped from outside its window. */
	stoppedFromOutside?: boolean;
}

const AWAY_KEY = Symbol.for("pi:away");

type GlobalAway = Record<symbol, AwayState | undefined>;

function state(): AwayState {
	const global = globalThis as GlobalAway;
	let found = global[AWAY_KEY];
	if (!found) {
		found = { held: [], decided: [], listeners: new Set() };
		global[AWAY_KEY] = found;
	}
	return found;
}

function changed(): void {
	const now = snapshot();
	for (const listener of state().listeners) {
		try {
			listener(now);
		} catch {
			// A listener left by an extension copy a reload replaced holds a
			// stale `pi` that throws. The state changed regardless, and the
			// live copy's listener says so.
		}
	}
}

/**
 * Say that the run under way is being stopped from outside its window,
 * as a steer's stop or pause does, so the abort it ends with is not
 * taken for the person pressing Escape, which ends an absence.
 */
export function stoppingFromOutside(): void {
	state().stoppedFromOutside = true;
}

/**
 * Whether the run that just ended was stopped from outside its window,
 * clearing the mark so it speaks for that run alone.
 */
export function takeStoppedFromOutside(): boolean {
	const current = state();
	const was = current.stoppedFromOutside === true;
	current.stoppedFromOutside = false;
	return was;
}

/** Whether the person is away. */
export function isAway(): boolean {
	return state().since !== undefined;
}

/**
 * Begin an absence. Returns false when one is already under way, in
 * which case a goal given now replaces the old one, since the person
 * said it more recently.
 */
export function goAway(goal?: string, now: Date = new Date()): boolean {
	const current = state();
	if (current.since !== undefined) {
		if (goal && goal !== current.goal) {
			current.goal = goal;
			changed();
		}
		return false;
	}
	current.since = now.toISOString();
	current.goal = goal;
	current.held = [];
	current.decided = [];
	changed();
	return true;
}

/** The goal of the absence under way, if one was given. */
export function awayGoal(): string | undefined {
	return state().goal;
}

/**
 * End the absence and hand over what waited. Undefined when the person
 * was not away.
 */
export function comeBack(): Return | undefined {
	const current = state();
	if (current.since === undefined) return undefined;
	const back: Return = {
		since: current.since,
		...(current.goal !== undefined ? { goal: current.goal } : {}),
		held: current.held,
		decided: current.decided,
	};
	current.since = undefined;
	current.goal = undefined;
	current.held = [];
	current.decided = [];
	changed();
	return back;
}

/** The fingerprint a gate's call is known by: guard, title and body. */
export function fingerprintOf(
	guard: string,
	title: string,
	body?: string,
): string {
	return createHash("sha256")
		.update(JSON.stringify([guard, title, body ?? ""]))
		.digest("hex");
}

/**
 * Hold a call for the person's return. The same call held twice is one
 * hold, so a model that retries does not pile up copies.
 */
export function hold(
	call: { guard: string; title: string; body?: string },
	now: Date = new Date(),
): HeldCall {
	const current = state();
	const fingerprint = fingerprintOf(call.guard, call.title, call.body);
	const existing = current.held.find((h) => h.fingerprint === fingerprint);
	if (existing) return existing;
	const held: HeldCall = {
		id: current.held.length + 1,
		guard: call.guard,
		title: call.title,
		...(call.body !== undefined ? { body: call.body } : {}),
		fingerprint,
		at: now.toISOString(),
	};
	current.held.push(held);
	changed();
	return held;
}

/** Record a question answered without the person. */
export function decide(
	decision: Omit<Decision, "at">,
	now: Date = new Date(),
): void {
	state().decided.push({ ...decision, at: now.toISOString() });
	changed();
}

/** Calls held so far in this absence. */
export function heldCalls(): readonly HeldCall[] {
	return state().held;
}

/**
 * Say where the work stands, for the nudge that keeps an unattended run
 * going. Quest-workflow provides it; passing undefined withdraws it.
 */
export function setProgressSource(
	source: (() => PlanProgress | undefined) | undefined,
): void {
	state().progress = source;
}

/** Where the work stands, if anything tracks it. */
export function planProgress(): PlanProgress | undefined {
	try {
		return state().progress?.();
	} catch {
		// A source left by an extension copy a reload replaced may read
		// state that is gone. No progress is the honest answer.
		return undefined;
	}
}

/** Everything, as data to store. */
export function snapshot(): AwaySnapshot {
	const current = state();
	return {
		...(current.since !== undefined ? { since: current.since } : {}),
		...(current.goal !== undefined ? { goal: current.goal } : {}),
		held: [...current.held],
		decided: [...current.decided],
	};
}

/** Put back what a snapshot holds, as a restored session does. */
export function restore(saved: AwaySnapshot): void {
	const current = state();
	current.since = saved.since;
	current.goal = saved.goal;
	current.held = [...saved.held];
	current.decided = [...saved.decided];
	changed();
}

/** Be told whenever anything here changes. Returns a disposer. */
export function onAwayChange(listener: Listener): () => void {
	const listeners = state().listeners;
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Forget everything but the listeners. For tests. */
export function resetAway(): void {
	const current = state();
	current.since = undefined;
	current.goal = undefined;
	current.held = [];
	current.decided = [];
	current.progress = undefined;
	current.stoppedFromOutside = false;
}

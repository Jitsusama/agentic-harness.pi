/**
 * The outbox a finished background job's result waits in.
 *
 * A result is said as a user message, since pi starts a run from a
 * custom message without `before_agent_start` and that run would go out
 * on the base system prompt, rewriting the whole cache twice. So the
 * outbox sends through pi's prompt path, and only when nothing else is
 * under way, because each other moment was measured or read to go wrong:
 *
 * - While a run streams, a queued user message is put into the
 *   person's editor by Escape. The outbox holds it until the run
 *   settles, which is when a follow-up would have landed anyway.
 * - While a compaction runs, pi refuses a prompt.
 * - While the person's prompt is between `input` and `agent_start`, a
 *   new prompt takes its place and leaves a run Escape cannot stop.
 *
 * The first two are pi's own idea of idle, asked rather than tracked,
 * so no missed event can leave the outbox thinking something is under
 * way. The third pi cannot say, so the outbox marks it from `input`.
 *
 * A session busy for a long run never had a moment like that: on 9
 * November a council's end reached its session 17 minutes late, behind
 * back-to-back tool calls, and a deploy waited on it (E2ZIAQ [1f2b4c5d];
 * N3Q98W measured a median of about 6.5 minutes [ea765cc0]). So while a
 * run is under way, a result is steered into it instead, as a custom
 * message pi reads after the tool calls in flight. That is no user
 * message, so Escape never puts it in the person's editor, and it starts
 * no run of its own, so the cache isn't rewritten. One the run never
 * read is said again once it settles.
 *
 * Except a run that was stopped: then it waits for the next tick. A
 * compaction stops the run it interrupts and waits for the session to
 * go idle, and pi starts a prompt sent as the run settles before it
 * lets that compaction in. On 9 November two sessions each said a
 * result there, then waited about nine hours to compact, since every
 * run's end brought another, while their context climbed from 180k to
 * 740k. A tick later the compaction is under way, and pi is not idle
 * until it ends.
 *
 * Everything ready goes in one message, since pi says queued messages
 * one at a time. A result leaves only once its message is seen in the
 * session, so a send that went nowhere (a stale `pi`, a refused prompt,
 * a run that ended without it) is sent again rather than lost.
 */

import { automatedHeader } from "../../lib/internal/automated.ts";

/** A finished job's result, bounded, ready to say. */
export interface JobResult {
	readonly jobId: string;
	readonly label: string;
	readonly text: string;
}

/** Where the outbox's message goes, and what it asks of the session. */
export interface OutboxOptions {
	/** Start a run with this as the prompt. May throw. */
	send(message: string): void;
	/**
	 * Put this into the run under way, read after its tool calls; throws
	 * when there is no run to put it in. Without it, results wait for the
	 * run to settle.
	 */
	steer?(message: string): void;
	/** No run active and no compaction, by pi's own account. */
	idle(): boolean;
	now(): number;
	/**
	 * Call `tick` every `ms` until the answer is called. The outbox asks
	 * only while something waits; without it, only its caller ticks it.
	 */
	every?(ms: number, tick: () => void): () => void;
}

/** The outbox, told what the session is doing. */
export interface Outbox {
	/** Queue a result, and send it if nothing is under way. */
	post(result: JobResult): void;
	/** A prompt was submitted and has not become a run yet. */
	promptSubmitted(): void;
	runStarted(): void;
	/**
	 * A run ended: whatever of ours it did not carry is sent again, at
	 * once, or on the next tick when the run was stopped.
	 */
	runSettled(stopped?: boolean): void;
	/** A user message reached the session; any result it carries is said. */
	seen(text: string): void;
	/** Drop a result still queued. False once it has been sent. */
	withdraw(jobId: string): boolean;
	/** Something changed or time passed: send whatever can go. */
	tick(): void;
	/** Stop looking again on its own, as a session parking does. */
	pause(): void;
	/** Look again on its own while something waits. */
	resume(): void;
	/** Results not yet seen in the session, in the order they finished. */
	waiting(): readonly JobResult[];
}

/**
 * How long a prompt may take to become a run before it is taken to have
 * gone nowhere. pi's prompt path awaits every `before_agent_start`
 * handler first, so this is generous; a refused prompt says nothing, so
 * something has to bound it.
 */
export const PROMPT_WAIT_MS = 30_000;

/**
 * How often the outbox looks again while something waits, for a run to
 * settle or a prompt that went nowhere. Nothing waiting, it looks never:
 * a tick a second in each of 94 idle pis woke them for nothing, while
 * their slice swapped (11 November).
 */
export const TICK_MS = 1_000;

/** The custom message a result steered into a run goes as. */
export const STEERED_RESULTS = "job-results";

/** How the message opens, so the model and the person know nobody typed it. */
export const OUTBOX_HEADER = automatedHeader("background work is reporting");

/**
 * The header older code sent. A result sent just before a reload is
 * seen by the code that loads after it, so both are recognised.
 */
const OLDER_HEADER = automatedHeader("background jobs are reporting");

/** Whether a message is the outbox's, from this code or older. */
export function isOutboxMessage(text: string): boolean {
	return text.startsWith(OUTBOX_HEADER) || text.startsWith(OLDER_HEADER);
}

/** The jobs an outbox message reports, by id; none for any other text. */
export function jobIdsIn(text: string): string[] {
	if (!isOutboxMessage(text)) return [];
	return [...text.matchAll(/\[(?:job )?(j\d+)\]/g)].flatMap(([, id]) =>
		id === undefined ? [] : [id],
	);
}

/** A result's tag in the message, which is how its landing is recognised. */
const tag = (jobId: string) => `[${jobId}]`;

/** Whether a message says this result, under this code's tag or older code's. */
const says = (text: string, jobId: string) =>
	text.includes(tag(jobId)) || text.includes(`[job ${jobId}]`);

/** The message that says these results. */
function compose(results: readonly JobResult[]): string {
	return [
		OUTBOX_HEADER,
		...results.map(
			(result) => `${tag(result.jobId)} ${result.label}\n${result.text}`,
		),
	].join("\n\n");
}

/** An outbox that sends through `options.send`. */
export function createOutbox(options: OutboxOptions): Outbox {
	const queued: JobResult[] = [];
	let out: JobResult[] = [];
	// When a prompt, ours or the person's, was submitted and has not yet
	// become a run.
	let promptSince: number | undefined;
	// Whether a run is under way, from its start until it settles.
	let running = false;
	let paused = false;
	let stopClock: (() => void) | undefined;

	// Looks again on its own only while a result or a prompt waits.
	const keepClock = () => {
		const waits =
			queued.length > 0 || out.length > 0 || promptSince !== undefined;
		if (!paused && waits) {
			stopClock ??= options.every?.(TICK_MS, () => box.tick());
		} else if (stopClock) {
			stopClock();
			stopClock = undefined;
		}
	};

	const giveBack = () => {
		queued.unshift(...out);
		out = [];
	};

	const trySteer = () => {
		if (!running || !options.steer) return;
		if (out.length > 0 || queued.length === 0) return;
		const sending = queued.splice(0);
		try {
			options.steer(compose(sending));
		} catch {
			// No run to put it in after all: it waits for the next moment.
			queued.unshift(...sending);
			return;
		}
		out = sending;
	};

	const trySend = () => {
		if (running) {
			trySteer();
			return;
		}
		if (out.length > 0 || queued.length === 0) return;
		if (promptSince !== undefined || !options.idle()) return;
		const sending = queued.splice(0);
		try {
			options.send(compose(sending));
		} catch {
			// Nothing went out: a stale `pi` after a reload throws. Kept for
			// the next tick.
			queued.unshift(...sending);
			return;
		}
		out = sending;
		promptSince = options.now();
	};

	const box: Outbox = {
		post(result) {
			queued.push(result);
			trySend();
			keepClock();
		},
		promptSubmitted() {
			if (options.idle()) promptSince ??= options.now();
			keepClock();
		},
		runStarted() {
			promptSince = undefined;
			running = true;
			trySteer();
			keepClock();
		},
		runSettled(stopped = false) {
			promptSince = undefined;
			running = false;
			giveBack();
			if (!stopped) trySend();
			keepClock();
		},
		seen(text) {
			if (!isOutboxMessage(text)) return;
			const said = (result: JobResult) => says(text, result.jobId);
			out = out.filter((result) => !said(result));
			for (let i = queued.length - 1; i >= 0; i--) {
				const result = queued[i];
				if (result && said(result)) queued.splice(i, 1);
			}
			keepClock();
		},
		withdraw(jobId) {
			const at = queued.findIndex((result) => result.jobId === jobId);
			if (at < 0) return false;
			queued.splice(at, 1);
			keepClock();
			return true;
		},
		tick() {
			const now = options.now();
			if (promptSince !== undefined && now - promptSince >= PROMPT_WAIT_MS) {
				promptSince = undefined;
				giveBack();
			}
			trySend();
			keepClock();
		},
		pause() {
			paused = true;
			keepClock();
		},
		resume() {
			paused = false;
			keepClock();
		},
		waiting: () => [...out, ...queued],
	};
	return box;
}

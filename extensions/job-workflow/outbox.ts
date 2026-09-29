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
 * Everything ready goes in one message, since pi says queued messages
 * one at a time. A result leaves only once its message is seen in the
 * session, so a send that went nowhere (a stale `pi`, a refused prompt,
 * a run that ended without it) is sent again rather than lost.
 */

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
	/** No run active and no compaction, by pi's own account. */
	idle(): boolean;
	now(): number;
}

/** The outbox, told what the session is doing. */
export interface Outbox {
	/** Queue a result, and send it if nothing is under way. */
	post(result: JobResult): void;
	/** A prompt was submitted and has not become a run yet. */
	promptSubmitted(): void;
	runStarted(): void;
	/** A run ended: whatever of ours it did not carry is sent again. */
	runSettled(): void;
	/** A user message reached the session; any result it carries is said. */
	seen(text: string): void;
	/** Something changed or time passed: send whatever can go. */
	tick(): void;
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

/** How the message opens, so the model and the person know nobody typed it. */
export const OUTBOX_HEADER =
	"[Automated message, no human input: background jobs you started have finished.]";

/** A job's tag in the message, which is how its landing is recognised. */
const tag = (jobId: string) => `[job ${jobId}]`;

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

	const giveBack = () => {
		queued.unshift(...out);
		out = [];
	};

	const trySend = () => {
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

	return {
		post(result) {
			queued.push(result);
			trySend();
		},
		promptSubmitted() {
			if (options.idle()) promptSince ??= options.now();
		},
		runStarted() {
			promptSince = undefined;
		},
		runSettled() {
			promptSince = undefined;
			giveBack();
			trySend();
		},
		seen(text) {
			if (!text.startsWith(OUTBOX_HEADER)) return;
			const said = (result: JobResult) => text.includes(tag(result.jobId));
			out = out.filter((result) => !said(result));
			for (let i = queued.length - 1; i >= 0; i--) {
				const result = queued[i];
				if (result && said(result)) queued.splice(i, 1);
			}
		},
		tick() {
			const now = options.now();
			if (promptSince !== undefined && now - promptSince >= PROMPT_WAIT_MS) {
				promptSince = undefined;
				giveBack();
			}
			trySend();
		},
		waiting: () => [...out, ...queued],
	};
}

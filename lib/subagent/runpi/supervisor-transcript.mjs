/**
 * What a reviewer said, spent and verified, read off pi's event stream
 * one event at a time: the answer it gave, finished or still being
 * written when the run ended, its usage, the sessions it announced,
 * how its last turn stopped, whether its run ended, and what
 * verify_output accepted. Also what each event says it is doing, for
 * progress.
 *
 * One transcript per run, held by the supervisor; nothing here is
 * module state. Plain `.mjs`, as the supervisor is, because node runs
 * that script directly and won't strip types under `node_modules`.
 */

import {
	assistantMessage,
	isFinishedMessage,
	sessionOf,
	textOf,
	usageOf,
	// biome-ignore lint/correctness/useImportExtensions: Biome reads the .d.mts beside this .mjs as the module and asks for .mjs.mts, a file that doesn't exist.
} from "./assistant.mjs";
import { trim, truncateBytes } from "./supervisor-text.mjs";

/**
 * A value parsed from pi's event stream. Nothing vouches for its
 * shape, so each field is checked where it is read, and this type
 * claims nothing more than that.
 *
 * @typedef {any} Parsed
 */
/** @typedef {import("./assistant.d.mts").AssistantUsage} Usage */
/** @typedef {import("../subagent.ts").ReviewerVerification} Verification */
/** @typedef {import("../reviewer-error.ts").ReviewerError} ReviewerError */

/**
 * The stop reason of a run that exited without ending. The same string
 * as `UNFINISHED` in `reviewer-error.ts`, which this script cannot
 * import; the supervisor suite checks the two agree.
 */
const UNFINISHED = "unfinished";

/** Pi's two words for a run that is over: ended, then settled. */
const RUN_OVER = new Set(["agent_end", "agent_settled"]);

/**
 * A run's transcript, read event by event.
 *
 * @param {{ maxAssistantTextBytes: number, warn: (message: string) => void }} options
 */
export function transcript(options) {
	const { maxAssistantTextBytes, warn } = options;
	let finalAssistantText = "";
	// The message still being written when the run ends, and what that
	// turn had run up. Both are the only account of a turn nobody let
	// finish, and a stopped reviewer's answer is usually inside it.
	let pendingAssistantText = "";
	/** @type {Usage | undefined} */
	let pendingUsage;
	/** @type {string | undefined} */
	let finalStopReason;
	/** @type {string | undefined} */
	let finalErrorMessage;
	/** @type {Usage | undefined} */
	let usage;
	// Every session the child announced. Watched from its first byte, so an
	// empty list is known: a child that never announced made no request.
	/** @type {string[]} */
	const sessionIds = [];
	/** @type {Verification | undefined} */
	let verification;
	const pendingVerifyCalls = new Map();
	/** @type {Parsed} */
	let lastUnkeyedVerifyArgs;
	// Whether pi said its run was over, and which tools it had started and
	// not yet finished. A child that exits 0 without the first did not
	// finish: Node leaves when nothing holds its event loop, and that used
	// to happen in the middle of a web read, reported here as "complete".
	let runEnded = false;
	const runningTools = new Map();

	/** @param {Parsed} event */
	function noteRunProgress(event) {
		if (!event || typeof event !== "object") return;
		if (RUN_OVER.has(event.type)) runEnded = true;
		const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
		if (!callId) return;
		if (event.type === "tool_execution_start")
			runningTools.set(callId, String(event.toolName ?? "a tool"));
		if (event.type === "tool_execution_end") runningTools.delete(callId);
	}

	/** @param {unknown} event */
	function captureAssistantMessage(event) {
		const message = assistantMessage(event);
		if (!message) return;
		const text = textOf(message);
		const nextUsage = usageOf(message);

		// A turn's usage is a running total, not an increment, so a
		// partial's is held rather than added: held it can be replaced by
		// the next update and counted once at the end, where adding it
		// would bill the turn once per update. Skipping it outright is the
		// opposite mistake and bills a stopped reviewer's longest turn at
		// nothing, which deletes the number that made this class of
		// failure visible. The stop reason is not read off a partial
		// either: a turn still running has not decided how it ends.
		if (!isFinishedMessage(event)) {
			if (text !== null)
				pendingAssistantText = truncateBytes(text, maxAssistantTextBytes, warn);
			if (nextUsage !== undefined) pendingUsage = nextUsage;
			return;
		}

		if (text !== null)
			finalAssistantText = truncateBytes(text, maxAssistantTextBytes, warn);
		pendingAssistantText = "";
		pendingUsage = undefined;
		if (nextUsage !== undefined) usage = addUsage(usage, nextUsage);
		// Track the last assistant turn's terminal signal. Only finished
		// assistant messages get this far, so the last one to arrive
		// carries the run's true stop reason: "error" when a provider or
		// transport failure ended the turn. Capture the stop reason and
		// its error message together from the same message so a later
		// error can never be paired with a stale message from an earlier
		// turn.
		if (typeof message.stopReason === "string") {
			finalStopReason = message.stopReason;
			finalErrorMessage =
				typeof message.errorMessage === "string"
					? message.errorMessage
					: undefined;
		}
	}

	/** @param {Parsed} event */
	function captureVerification(event) {
		if (!event || typeof event !== "object") return;
		const toolName = typeof event.toolName === "string" ? event.toolName : "";
		if (toolName !== "verify_output") return;
		const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
		if (event.type === "tool_execution_start") {
			const args = objectValue(event.args);
			if (callId) {
				pendingVerifyCalls.set(callId, args);
				trimPendingVerifyCalls();
			} else {
				lastUnkeyedVerifyArgs = args;
			}
			return;
		}
		if (event.type !== "tool_execution_end") return;
		const rawArgs = callId ? pendingVerifyCalls.get(callId) : undefined;
		const args =
			rawArgs ?? objectValue(event.args) ?? lastUnkeyedVerifyArgs ?? {};
		if (callId) pendingVerifyCalls.delete(callId);
		else lastUnkeyedVerifyArgs = undefined;
		const result = objectValue(event.result) ?? {};
		const details = objectValue(result.details) ?? {};
		const message = verifierMessage(result);
		const ok = details.ok === true;
		// Per-stage verify extensions emit `stage` on
		// `details`; older `args.stage` is honoured as a
		// fallback for any callers still on the single-tool
		// shape.
		const stage =
			typeof details.stage === "string"
				? details.stage
				: typeof args.stage === "string"
					? args.stage
					: undefined;
		verification = {
			called: true,
			ok,
			...(stage !== undefined ? { stage } : {}),
			...(typeof details.count === "number" ? { count: details.count } : {}),
			...(Array.isArray(details.warnings)
				? {
						warnings: details.warnings.filter(
							(/** @type {unknown} */ warning) => typeof warning === "string",
						),
					}
				: {}),
			...(message ? { message } : {}),
			...(ok && "output" in args
				? { output: normalizedVerifierOutput(args.output) }
				: {}),
		};
	}

	function trimPendingVerifyCalls() {
		const maxPendingVerifyCalls = 8;
		while (pendingVerifyCalls.size > maxPendingVerifyCalls) {
			const oldest = pendingVerifyCalls.keys().next().value;
			if (oldest === undefined) return;
			pendingVerifyCalls.delete(oldest);
		}
	}

	/** Everything the assistant had said, finished messages and the one in flight. */
	function saidSoFar() {
		if (pendingAssistantText === "") return finalAssistantText;
		if (finalAssistantText === "") return pendingAssistantText;
		return `${finalAssistantText}\n\n${pendingAssistantText}`;
	}

	return {
		/** Every session the child announced, in the order it did. */
		sessionIds,

		/**
		 * Take one event off the stream.
		 *
		 * @param {Parsed} event
		 */
		read(event) {
			const announced = sessionOf(event);
			if (announced !== null) sessionIds.push(announced);
			noteRunProgress(event);
			captureAssistantMessage(event);
			captureVerification(event);
		},

		/**
		 * A line too large to parse: read what kind of event it was.
		 *
		 * agent_end carries every message of the run, so on a long run it is
		 * the line most likely to be over the cap. Pi writes the type first,
		 * so the head of the line says what it was without parsing the rest.
		 *
		 * @param {string} text
		 */
		skipped(text) {
			const kind = /^\s*\{"type":"([a-z_]+)"/.exec(text)?.[1];
			if (kind !== undefined && RUN_OVER.has(kind)) runEnded = true;
		},

		/**
		 * Take up the verification verify_output wrote out-of-band, which
		 * outranks what the stream carried; nothing changes without one.
		 *
		 * @param {Verification | undefined} written
		 */
		adopt(written) {
			if (written) verification = written;
		},

		/**
		 * The error a run in `state` ends with: its last turn's when that
		 * stopped on an error, else, for a child that exited cleanly
		 * without ending its run, that it was unfinished.
		 *
		 * A crashed stream still exits 0, so the first is the only signal
		 * that separates a dropped reviewer from one that finished
		 * cleanly. Once the run has said it ended, a tool with no recorded
		 * end is a line we could not read rather than a tool still
		 * running, so only a run that never ended is unfinished.
		 *
		 * @param {string} state
		 * @returns {ReviewerError | undefined}
		 */
		error(state) {
			if (finalStopReason === "error")
				return {
					stopReason: finalStopReason,
					message:
						finalErrorMessage ??
						"Reviewer run ended on an error with no message.",
				};
			if (state !== "complete" || runEnded) return undefined;
			const still = [...new Set(runningTools.values())];
			const during =
				still.length > 0 ? ` while ${still.join(", ")} was still running` : "";
			return {
				stopReason: UNFINISHED,
				message: `pi exited with code 0${during}, before its run ended; whatever it was working towards was never said.`,
			};
		},

		/**
		 * What the result carries of the run's answer: the text, what was
		 * said or the verified output as JSON when verify_output accepted
		 * one, and the verification as that text leaves it, without a
		 * stream-captured output, which the text already holds.
		 */
		answer() {
			const text = finalText();
			return { text, verification: verificationWithoutOutput(verification) };
		},

		/** What the run cost, counting the turn nobody let finish. */
		usage() {
			return pendingUsage === undefined ? usage : addUsage(usage, pendingUsage);
		},
	};

	/**
	 * The answer's text. It marks the verification by what it found, so
	 * `answer` reads the verification after it.
	 */
	function finalText() {
		if (!verification?.ok) return saidSoFar();
		// Out-of-band output is carried whole in
		// verification.output (written to result.json, which has
		// no cap) and read there by the parent. Do not serialize
		// it into finalAssistantText, where the assistant-text
		// cap would invalidate a large-but-valid review.
		if (verification.outOfBand) return "";
		if (!("output" in verification)) {
			verification = {
				...verification,
				ok: false,
				message:
					"verify_output returned ok: true but the verified payload was not captured.",
			};
			return "";
		}
		const text = JSON.stringify(verification.output, null, 2);
		if (Buffer.byteLength(text) > maxAssistantTextBytes) {
			const message = `Reviewer verified output exceeded ${maxAssistantTextBytes} bytes; ignored`;
			warn(message);
			verification = { ...verification, ok: false, message };
			return "";
		}
		verification = { ...verification, canonicalText: true };
		return text;
	}
}

// Pi emits one message_end per turn, each carrying that turn's own
// usage, so a run's total is their sum. Keeping only the last turn
// (an earlier bug) reported a fraction of the true tokens and cost.
/**
 * @param {Usage | undefined} total
 * @param {Usage} turn
 * @returns {Usage}
 */
function addUsage(total, turn) {
	if (total === undefined) return turn;
	return {
		tokens: {
			input: total.tokens.input + turn.tokens.input,
			output: total.tokens.output + turn.tokens.output,
			cacheRead: total.tokens.cacheRead + turn.tokens.cacheRead,
			cacheWrite: total.tokens.cacheWrite + turn.tokens.cacheWrite,
			total: total.tokens.total + turn.tokens.total,
		},
		cost: {
			input: total.cost.input + turn.cost.input,
			output: total.cost.output + turn.cost.output,
			cacheRead: total.cost.cacheRead + turn.cost.cacheRead,
			cacheWrite: total.cost.cacheWrite + turn.cost.cacheWrite,
			total: total.cost.total + turn.cost.total,
		},
	};
}

/**
 * @param {Verification | undefined} value
 * @returns {Verification | undefined}
 */
function verificationWithoutOutput(value) {
	if (!value || typeof value !== "object" || !("output" in value)) return value;
	// Out-of-band output is the payload the parent reads from
	// result.json; keep it. Stream-captured output stays
	// stripped, since there it is redundant with the
	// canonical finalAssistantText.
	if (value.outOfBand) return value;
	const { output: _output, ...rest } = value;
	return rest;
}

/**
 * @param {unknown} value
 * @returns {Parsed}
 */
function objectValue(value) {
	return value && typeof value === "object" ? value : undefined;
}

/**
 * @param {Parsed} result
 * @returns {string}
 */
function verifierMessage(result) {
	const content = Array.isArray(result.content) ? result.content : [];
	for (const part of content) {
		if (part && typeof part === "object" && typeof part.text === "string") {
			return part.text;
		}
	}
	return "";
}

/**
 * @param {unknown} output
 * @returns {unknown}
 */
function normalizedVerifierOutput(output) {
	if (typeof output !== "string") return output;
	try {
		return JSON.parse(output);
	} catch {
		// If the verifier accepted a non-JSON string for some future stage,
		// keep the original value instead of failing the supervisor result.
		return output;
	}
}

/**
 * What an event says the reviewer is doing, in a few words for its
 * progress, or null when it says nothing of the kind.
 *
 * @param {Parsed} event
 * @returns {string | null}
 */
export function summarizeActivity(event) {
	if (!event || typeof event !== "object") return null;
	const toolName = typeof event.toolName === "string" ? event.toolName : "";
	if (!toolName) return null;
	if (event.type === "tool_execution_end")
		return `finished ${toolAction(toolName)}; waiting for model`;
	if (event.type !== "tool_execution_start") return null;
	const args = event.args && typeof event.args === "object" ? event.args : {};
	if (toolName === "read" || toolName === "Read")
		return args.path ? `reading ${trim(args.path, 40)}` : "reading";
	if (toolName === "grep" || toolName === "Grep")
		return args.pattern ? `grep ${trim(args.pattern, 40)}` : "grep";
	if (toolName === "glob" || toolName === "Glob")
		return args.pattern ? `glob ${trim(args.pattern, 40)}` : "glob";
	if (toolName === "ls" || toolName === "Ls")
		return args.path ? `ls ${trim(args.path, 40)}` : "ls";
	if (toolName === "bash" || toolName === "Bash")
		return args.command ? `bash ${trim(args.command, 40)}` : "bash";
	if (toolName === "verify_output") return "verifying output";
	return `running ${toolName}`;
}

/** @param {string} toolName */
function toolAction(toolName) {
	if (toolName === "read" || toolName === "Read") return "reading";
	if (toolName === "verify_output") return "verifying output";
	return toolName;
}

#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
	appendFile,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { createGzip } from "node:zlib";
import {
	JOURNAL_PATH_VAR,
	JOURNAL_SAYS,
	journalWarnings,
	parseJournal,
} from "./journal.mjs";
import { clockVerdict } from "./watchdog.mjs";

const requestPath = process.argv[2];
if (!requestPath) {
	console.error("Usage: supervisor.mjs <request.json>");
	process.exit(2);
}

const request = JSON.parse(await readFile(requestPath, "utf-8"));
// Wall clock and idle allowances for a run nobody said anything
// about. Generous, because a large stack-aware council or judge run
// legitimately takes longer than twenty minutes.
//
// These used to be floors, applied with Math.max, which meant a
// caller asking for a short leash silently got forty-five minutes
// instead. The parent defaults to the same numbers, so the floor
// protected nothing and only overruled people. It also made this
// script's own watchdog untestable, and that is not academic: it is
// why a supervisor still starting its child when the parent gave up
// had nothing of its own to say. The parent killed it and reported
// silence, one CI run in three, for an afternoon.
const TIMEOUT_DEFAULT_MS = 45 * 60 * 1000;

/**
 * How long a departed reviewer's pipes may stay open before this
 * finishes without them. Long enough for a real flush, short
 * enough that nobody mistakes it for a hang.
 */
const STDIO_GRACE_MS = 2_000;
const IDLE_DEFAULT_MS = 15 * 60 * 1000;

if (typeof request.timeoutMs !== "number") {
	request.timeoutMs = TIMEOUT_DEFAULT_MS;
}
if (typeof request.idleTimeoutMs !== "number") {
	request.idleTimeoutMs = IDLE_DEFAULT_MS;
}
const startedAt = new Date().toISOString();
const warnings = [];
let finalAssistantText = "";
// The message still being written when the run ends, and what that
// turn had run up. Both are the only account of a turn nobody let
// finish, and a stopped reviewer's answer is usually inside it.
let pendingAssistantText = "";
let pendingUsage;
let finalStopReason;
let finalErrorMessage;
let usage;
let verification;
let stderrTail = "";
let stdoutBuffer = "";
const pendingVerifyCalls = new Map();
let lastUnkeyedVerifyArgs;
let discardingOversizedLine = false;
let child = null;
let stoppedBy = null;
let settled = false;
let lastActivityAt = Date.now();
let killTimer = null;
let heartbeatTimer = null;
let watchdogTimer = null;
let childStartedAt = null;
// Close enough: a few milliseconds after the operating system's own
// stamp, which is the same slack the child's comparison already
// allows for.
const supervisorStartedAt = Date.now();
let reportTimer = null;
// A ref'd keepalive so the event loop cannot drain and exit the
// process while the async child-close handler's finish() is still
// writing the result file. The heartbeat and watchdog timers are
// unref'd on purpose, so without this the loop could end cleanly
// (exit code 0) mid-finish under load, leaving no terminal result and
// an empty final message. finish() clears it just before it exits, so
// the only clean exit is through finish(); the unref'd watchdog still
// fires because this keeps the loop alive.
const runKeepAlive = setInterval(() => {}, 1 << 30);
let stdoutTask = Promise.resolve();
let stderrTask = Promise.resolve();

await mkdir(request.paths.reviewerDir, { recursive: true });
// Persisted sessions land here (via --session-dir). Create
// it up front so pi never races a missing directory, and so
// a resume has a stable location to reopen.
if (request.paths.sessionDir) {
	await mkdir(request.paths.sessionDir, { recursive: true });
}
// A retry reuses the run id and reviewer id, so it lands in the
// same directory as the attempt before it. The verify_output
// envelope is written only on success and never overwritten on a
// failure, so a stale envelope from a prior success would be
// adopted as this attempt's verified result. Clear it before the
// spawn so "no envelope" reliably means "this attempt wrote none."
if (request.paths.verifiedOutputPath) {
	await rm(request.paths.verifiedOutputPath, { force: true });
}
// Same reasoning for the journal, and it matters more here: this
// file is appended to, so a leftover from an earlier attempt would
// be read as this one's findings and credited to a run that never
// made them.
if (request.paths.journalPath) {
	await rm(request.paths.journalPath, { force: true });
}
await writeJsonAtomic(request.paths.leasePath, lease("starting"));
await writeJsonAtomic(request.paths.progressPath, progress("pending", ""));

child = spawn(request.binary, request.args, {
	cwd: request.cwd,
	detached: true,
	stdio: ["ignore", "pipe", "pipe"],
	env: {
		...process.env,
		// Pin the child's asset resolution to the parent's
		// dereferenced install. Pi reads PI_PACKAGE_DIR to find
		// its theme and package.json; the raw inherited value can
		// name a versioned symlink a mid-session upgrade deletes,
		// so override it with the immutable store path the parent
		// captured at startup. Absent when the parent had no
		// PI_PACKAGE_DIR (self-locating installs need no override).
		...(request.piPackageDir ? { PI_PACKAGE_DIR: request.piPackageDir } : {}),
		// The supervisor speaks the subagent engine's env
		// vocabulary. pr-workflow is one consumer; the same
		// names will travel with the supervisor when it
		// moves into `lib/subagent/runpi/`.
		SUBAGENT_RUN_ID: request.runId,
		SUBAGENT_ID: request.reviewerId,
		SUBAGENT_SUPERVISOR: "1",
		// The verify_output tool writes its validated payload
		// here so a large review travels on a file, past the
		// event-stream and assistant-text caps that used to
		// drop it. Read back in finish() as out-of-band output.
		...(request.paths.verifiedOutputPath
			? { SUBAGENT_VERIFY_OUTPUT_PATH: request.paths.verifiedOutputPath }
			: {}),
		// Where a reviewer writes down a finding the moment it has
		// one, so an interruption costs the line it was writing
		// rather than the whole review.
		...(request.paths.journalPath
			? { [JOURNAL_PATH_VAR]: request.paths.journalPath }
			: {}),
	},
});

// The moment the child came into being, to the nearest millisecond
// this process can observe. Recorded because a pid on its own does
// not identify anything: the operating system reuses them, and
// whoever finds this lease after we are gone is about to decide
// whether to kill what it names. A process started before we spawned
// ours is not ours.
childStartedAt = Date.now();

emit({
	type: "started",
	runId: request.runId,
	reviewerId: request.reviewerId,
	pid: child.pid ?? 0,
	pgid: child.pid ?? undefined,
});
await writeJsonAtomic(request.paths.leasePath, lease("running"));
await writeJsonAtomic(
	request.paths.progressPath,
	progress("running", "spawned reviewer"),
);

child.stdout?.on("data", (chunk) => {
	stdoutTask = stdoutTask.then(() => handleStdout(chunk));
});
child.stderr?.on("data", (chunk) => {
	stderrTask = stderrTask.then(() => handleStderr(chunk));
});
child.once("error", async (error) => {
	warnings.push(`Supervisor failed to spawn reviewer: ${error.message}`);
	await finish("failed", 1);
});
child.once("close", async (code) => {
	if (settled) return;
	await finish(stateForClose(code), code ?? fallbackExitCode(stoppedBy));
});
// "close" means the child exited AND its stdio closed, and those
// are different events. Anything the child started that inherited
// its pipes and outlived it keeps them open, so "close" never
// arrives, finish() is never called and this supervisor waits for
// ever. The wall-clock watchdog does not save it: that kills the
// child, which is already dead, and the pipes stay held.
//
// A reviewer leaving a background process behind is ordinary, so
// this hung a whole fleet run on something the reviewer had every
// right to do. "exit" fires on the process alone, so it is the
// honest signal that the run is over; the pipes then get a short
// grace to deliver anything still buffered before we finish
// without them.
child.once("exit", (code) => {
	const grace = setTimeout(() => {
		if (settled) return;
		warnings.push(
			"Reviewer exited but left its output open; something it " +
				"started is still holding the pipes. Finished without them.",
		);
		void finish(stateForClose(code), code ?? fallbackExitCode(stoppedBy));
	}, STDIO_GRACE_MS);
	grace.unref?.();
});

// Both timers guard against overlapping themselves, and that guard is
// the other half of the fix above. An async body on a fixed interval
// starts another one whether or not the last finished, so a write or a
// stat that goes slow does not degrade, it compounds: at 500ms and 145
// seconds that is 290 outstanding calls, each adding syscalls to the
// queue that made the previous one slow. Skipping a tick we are too
// busy to honour is what degrading actually looks like.
let writingLease = false;
heartbeatTimer = setInterval(() => {
	if (writingLease) return;
	writingLease = true;
	void writeJsonAtomic(request.paths.leasePath, lease("running"))
		.catch(() => {
			// A missed beat is not worth a death. Without this catch a
			// full disk or a lost directory rejects, and an unhandled
			// rejection takes the supervisor down: the reviewer it is
			// watching becomes the orphan this whole mechanism exists to
			// prevent, killed off by the bookkeeping meant to protect it.
		})
		.finally(() => {
			writingLease = false;
		});
}, request.heartbeatMs ?? 1000);
heartbeatTimer.unref?.();

let checkingSignals = false;
watchdogTimer = setInterval(() => {
	if (checkClocks()) return;
	if (checkingSignals) return;
	checkingSignals = true;
	void checkSignals().finally(() => {
		checkingSignals = false;
	});
}, request.watchdogMs ?? 500);
watchdogTimer.unref?.();

process.once("SIGTERM", () => stopChild("cancelled"));
process.once("SIGINT", () => stopChild("cancelled"));

async function handleStdout(chunk) {
	lastActivityAt = Date.now();
	await appendRotating(request.paths.eventsPath, chunk, {
		maxBytes: request.maxEventBytes,
		maxRotations: request.maxEventRotations ?? 3,
	});
	stdoutBuffer += chunk.toString("utf-8");
	while (true) {
		const newlineIndex = stdoutBuffer.indexOf("\n");
		if (newlineIndex < 0) {
			checkLineBuffer();
			return;
		}
		const line = stdoutBuffer.slice(0, newlineIndex);
		stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
		await ingestLine(line);
	}
}

async function handleStderr(chunk) {
	lastActivityAt = Date.now();
	stderrTail = tail(
		`${stderrTail}${chunk.toString("utf-8")}`,
		request.stderrTailBytes,
	);
	await appendRotating(request.paths.stderrPath, chunk, {
		maxBytes: request.maxStderrBytes,
		maxRotations: request.maxStderrRotations ?? 3,
	});
}

async function ingestLine(line) {
	if (discardingOversizedLine) {
		discardingOversizedLine = false;
		return;
	}
	const trimmed = line.trim();
	if (!trimmed) return;
	if (Buffer.byteLength(trimmed) > request.maxLineBytes) {
		warn(
			`Reviewer stream line exceeded ${request.maxLineBytes} bytes; skipped`,
		);
		return;
	}
	let event;
	try {
		event = JSON.parse(trimmed);
	} catch {
		warn(`Malformed JSON event line: ${truncate(trimmed, 80)}`);
		return;
	}
	captureAssistantMessage(event);
	captureVerification(event);
	const activity = summarizeActivity(event);
	if (activity) {
		await writeJsonAtomic(
			request.paths.progressPath,
			progress("running", activity),
		);
		emit({
			type: "activity",
			runId: request.runId,
			reviewerId: request.reviewerId,
			activity,
			elapsedMs: Date.now() - Date.parse(startedAt),
			idleMs: Date.now() - lastActivityAt,
		});
	}
}

function checkLineBuffer() {
	if (
		!discardingOversizedLine &&
		Buffer.byteLength(stdoutBuffer) > request.maxLineBytes
	) {
		warn(
			`Reviewer stream line exceeded ${request.maxLineBytes} bytes; skipped`,
		);
		stdoutBuffer = "";
		discardingOversizedLine = true;
	}
}

/**
 * The watchdogs that need only the clock.
 *
 * Synchronous and first, because both of these are knowable without
 * asking anything, and they used to sit behind two stat calls that
 * answer a different question. Under I/O pressure that inverted the
 * priority exactly when it mattered: the checks that must fire were
 * gated on the resource that had run out.
 *
 * A run observed at load 168 renewed its lease every second for 145
 * seconds and never once enforced its own 120-second timeout, so the
 * parent's last-resort deadline had to kill it. Its event loop was
 * healthy the whole time. Only the order was wrong.
 *
 * Answers whether it stopped the child, so the caller can skip work
 * that no longer has a point.
 */
function checkClocks() {
	if (settled) return true;
	// Ahead of the cancel check now, where it used to be behind. Both
	// call the same idempotent stopChild, so the only difference is
	// which reason gets recorded when a run is cancelled in the same
	// tick it expires. Naming the deadline is the honest answer there,
	// and waiting to find out was the bug.
	const verdict = clockVerdict({
		now: Date.now(),
		startedAtMs: Date.parse(startedAt),
		timeoutMs: request.timeoutMs,
		softDeadlineMs: request.softDeadlineMs,
		lastActivityAtMs: lastActivityAt,
		idleTimeoutMs: request.idleTimeoutMs,
	});
	if (verdict === null) return false;
	stopChild(verdict);
	return true;
}

/** The watchdogs that have to ask the filesystem. */
async function checkSignals() {
	if (settled) return;
	if (
		(await exists(request.paths.cancelPath)) ||
		(await exists(request.runCancelPath))
	) {
		stopChild("cancelled");
		return;
	}
	if (!parentAlive()) stopChild("parent-exit");
}

function stopChild(reason) {
	if (stoppedBy !== null || settled) return;
	stoppedBy = reason;
	warn(stopWarning(reason));
	terminateChild("SIGTERM");
	killTimer = setTimeout(() => terminateChild("SIGKILL"), request.killGraceMs);
	killTimer.unref?.();

	// Reporting must not depend on the child saying it went.
	//
	// Every other road to finish() is an event from the child: error,
	// close, or exit. A child that has not been scheduled yet emits none
	// of them, and neither signal above reaches a process that does not
	// exist, so the supervisor sat here renewing its lease while its
	// parent waited out the entire budget and killed it. Seen three times
	// under load, each with a lease a few hundred milliseconds old beside
	// progress as old as the whole wait: a healthy process waiting on an
	// event that was never coming.
	//
	// Twice the kill grace, so the SIGKILL above gets its full chance to
	// produce a real exit first. This is the answer of last resort and
	// says so in the warnings, because reporting a run whose child may
	// still be alive is worth admitting to.
	reportTimer = setTimeout(() => {
		if (settled) return;
		warnings.push(
			`Reviewer never exited after ${reason}; reported without it. ` +
				"It may not have started at all.",
		);
		void finish(reason, fallbackExitCode(reason));
	}, request.killGraceMs * 2);
	reportTimer.unref?.();
}

async function finish(state, exitCode) {
	if (settled) return;
	settled = true;
	if (heartbeatTimer) clearInterval(heartbeatTimer);
	if (watchdogTimer) clearInterval(watchdogTimer);
	if (killTimer) clearTimeout(killTimer);
	if (reportTimer) clearTimeout(reportTimer);
	// runKeepAlive is cleared only at the very end, right before exit,
	// so the loop stays alive through every write below.
	await Promise.allSettled([stdoutTask, stderrTask]);
	if (stdoutBuffer.length > 0 && !discardingOversizedLine)
		await ingestLine(stdoutBuffer);
	stdoutBuffer = "";
	await adoptOutOfBandVerification();
	const journalled = await readJournal();
	// Reported to the round separately as well as warned about here,
	// because the round replaces a participant's warnings with its own
	// sentence and these say findings were dropped, which is the one
	// thing that must not travel in a channel nobody reads.
	const journalTrouble = warnings.filter((said) =>
		said.startsWith(JOURNAL_SAYS),
	);
	const sessionPath = await discoverSessionPath();
	// A reviewer's final turn can end on a provider or
	// transport error while the child still exits 0. Report
	// that honestly: the run is "errored", not "complete",
	// and the structured error travels on the result so the
	// parent can classify it and decide whether to resume.
	const error = reviewerErrorForResult();
	const reportedState = error && state === "complete" ? "errored" : state;
	const completedAt = new Date().toISOString();
	const result = {
		schemaVersion: 1,
		runId: request.runId,
		reviewerId: request.reviewerId,
		state: reportedState,
		exitCode,
		finalAssistantText: finalTextForResult(),
		...(journalled.length > 0 ? { journal: journalled } : {}),
		...(journalTrouble.length > 0 ? { journalWarnings: journalTrouble } : {}),
		usage: spentSoFar(),
		verification: verificationWithoutOutput(verification),
		...(error ? { error } : {}),
		warnings,
		stderrTail,
		startedAt,
		completedAt,
		artifacts: {
			runDir: request.paths.runDir,
			reviewerDir: request.paths.reviewerDir,
			eventsPath: request.paths.eventsPath,
			stderrPath: request.paths.stderrPath,
			progressPath: request.paths.progressPath,
			resultPath: request.paths.resultPath,
			...(request.paths.sessionDir
				? { sessionDir: request.paths.sessionDir }
				: {}),
			...(sessionPath ? { sessionPath } : {}),
		},
	};
	await writeJsonAtomic(request.paths.resultPath, result);
	await writeJsonAtomic(request.paths.progressPath, progress(state, ""));
	await writeJsonAtomic(request.paths.leasePath, {
		...lease(state),
		completedAt,
		exitCode,
	});
	emit({
		type: "terminal",
		runId: request.runId,
		reviewerId: request.reviewerId,
		state,
		exitCode,
		resultPath: request.paths.resultPath,
	});
	clearInterval(runKeepAlive);
	process.exit(0);
}

// Find the session file pi minted inside the private
// session dir. pi names it "<timestamp>_<uuid>.jsonl"; on a
// resume there may be more than one, so the newest wins.
// Returns undefined when the reviewer crashed before pi
// wrote any session, which is how a genuine no-session run
// stays distinct from a resumable one.
async function discoverSessionPath() {
	const dir = request.paths?.sessionDir;
	if (!dir) return undefined;
	let entries;
	try {
		entries = await readdir(dir);
	} catch {
		return undefined;
	}
	const sessions = entries.filter((name) => name.endsWith(".jsonl"));
	if (sessions.length === 0) return undefined;
	let newest;
	let newestMtime = -1;
	for (const name of sessions) {
		const full = `${dir}/${name}`;
		try {
			const mtime = (await stat(full)).mtimeMs;
			if (mtime > newestMtime) {
				newestMtime = mtime;
				newest = full;
			}
		} catch {
			// Raced deletion; skip.
		}
	}
	return newest;
}

/**
 * What the reviewer wrote down while it worked.
 *
 * One JSON object per line, and a line that will not parse costs that
 * line alone: a reviewer killed mid-write leaves a half-written last
 * line, and everything above it is intact and paid for. Dropping the
 * lot over the line the kill landed on would give up exactly what this
 * file exists to keep.
 */
async function readJournal() {
	const path = request.paths?.journalPath;
	if (!path) return [];
	let raw;
	try {
		raw = await readFile(path, "utf-8");
	} catch (error) {
		// No file is the ordinary case: the reviewer recorded nothing.
		// Anything else is a file we cannot read, which is not the same
		// as an empty one and must not be reported as one.
		if (error?.code !== "ENOENT") {
			warn(
				`${JOURNAL_SAYS} could not read back what this reviewer wrote down (${error?.code ?? error}); anything it recorded is still at ${path}`,
			);
		}
		return [];
	}
	const counts = parseJournal(raw);
	for (const said of journalWarnings(counts, path)) warn(said);
	return counts.entries;
}

async function adoptOutOfBandVerification() {
	// The verify_output tool writes a validated envelope to
	// this file. When present it is the source of truth: the
	// payload arrived out-of-band, so it bypassed the stream
	// line cap on the way here and must bypass the
	// assistant-text cap on the way back. A crashed reviewer
	// writes no file, which is how a genuine empty result
	// (an empty findings array on disk) stays distinct from a
	// crash (no file at all).
	const path = request.paths?.verifiedOutputPath;
	if (!path) return;
	let raw;
	try {
		raw = await readFile(path, "utf-8");
	} catch {
		return; // No envelope: fall back to stream-captured verification.
	}
	let envelope;
	try {
		envelope = JSON.parse(raw);
	} catch {
		warn("Verify-output envelope was not valid JSON; ignored");
		return;
	}
	if (!envelope || typeof envelope !== "object" || envelope.ok !== true) return;
	verification = {
		called: true,
		ok: true,
		outOfBand: true,
		...(typeof envelope.stage === "string" ? { stage: envelope.stage } : {}),
		...(typeof envelope.count === "number" ? { count: envelope.count } : {}),
		...(Array.isArray(envelope.warnings)
			? {
					warnings: envelope.warnings.filter((w) => typeof w === "string"),
				}
			: {}),
		...("output" in envelope ? { output: envelope.output } : {}),
	};
}

function captureAssistantMessage(event) {
	const message = assistantMessage(event);
	if (!message) return;
	const text = textContent(message);
	const nextUsage = readUsage(message);

	// A turn's usage is a running total, not an increment, so a
	// partial's is held rather than added: held it can be replaced by
	// the next update and counted once at the end, where adding it
	// would bill the turn once per update. Skipping it outright is the
	// opposite mistake and bills a stopped reviewer's longest turn at
	// nothing, which deletes the number that made this class of
	// failure visible. The stop reason is not read off a partial
	// either: a turn still running has not decided how it ends.
	if (event.type !== "message_end") {
		if (text !== null)
			pendingAssistantText = truncateBytes(text, request.maxAssistantTextBytes);
		if (nextUsage !== undefined) pendingUsage = nextUsage;
		return;
	}

	if (text !== null)
		finalAssistantText = truncateBytes(text, request.maxAssistantTextBytes);
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

// Build the structured terminal error when the last
// assistant turn stopped on an error. A crashed stream
// still exits 0, so this is the only signal that separates
// a dropped reviewer from one that finished cleanly.
function reviewerErrorForResult() {
	if (finalStopReason !== "error") return undefined;
	return {
		stopReason: finalStopReason,
		message:
			finalErrorMessage ?? "Reviewer run ended on an error with no message.",
	};
}

// Pi emits one message_end per turn, each carrying that turn's own
// usage, so a run's total is their sum. Keeping only the last turn
// (an earlier bug) reported a fraction of the true tokens and cost.
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
						(warning) => typeof warning === "string",
					),
				}
			: {}),
		...(message ? { message } : {}),
		...(ok && "output" in args
			? { output: normalizedVerifierOutput(args.output) }
			: {}),
	};
}

function objectValue(value) {
	return value && typeof value === "object" ? value : undefined;
}

function trimPendingVerifyCalls() {
	const maxPendingVerifyCalls = 8;
	while (pendingVerifyCalls.size > maxPendingVerifyCalls) {
		const oldest = pendingVerifyCalls.keys().next().value;
		if (oldest === undefined) return;
		pendingVerifyCalls.delete(oldest);
	}
}

function verifierMessage(result) {
	const content = Array.isArray(result.content) ? result.content : [];
	for (const part of content) {
		if (part && typeof part === "object" && typeof part.text === "string") {
			return part.text;
		}
	}
	return "";
}

/** Everything the assistant had said, finished messages and the one in flight. */
function saidSoFar() {
	if (pendingAssistantText === "") return finalAssistantText;
	if (finalAssistantText === "") return pendingAssistantText;
	return `${finalAssistantText}\n\n${pendingAssistantText}`;
}

/** What the run cost, counting the turn nobody let finish. */
function spentSoFar() {
	return pendingUsage === undefined ? usage : addUsage(usage, pendingUsage);
}

function finalTextForResult() {
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
	if (Buffer.byteLength(text) > request.maxAssistantTextBytes) {
		const message = `Reviewer verified output exceeded ${request.maxAssistantTextBytes} bytes; ignored`;
		warn(message);
		verification = { ...verification, ok: false, message };
		return "";
	}
	verification = { ...verification, canonicalText: true };
	return text;
}

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
 * The assistant message an event carries, finished or not.
 *
 * A finished message arrives as `message_end`; one still being written
 * arrives as `message_update` carrying the whole of itself so far. A
 * reviewer stopped at its budget never sends anything but updates for
 * its last message, so watching only for the end throws away an answer
 * that was nearly complete.
 */
function assistantMessage(event) {
	if (typeof event !== "object" || event === null) return null;
	const message =
		event.type === "message_end" ? event.message : streamedPart(event);
	if (typeof message !== "object" || message === null) return null;
	return message.role === "assistant" ? message : null;
}

/** The message so far, off an update event. */
function streamedPart(event) {
	if (event.type !== "message_update") return null;
	const streamed = event.assistantMessageEvent;
	if (typeof streamed !== "object" || streamed === null) return null;
	return streamed.partial ?? null;
}

function textContent(message) {
	if (!Array.isArray(message.content)) return null;
	const parts = [];
	for (const part of message.content) {
		if (
			part &&
			typeof part === "object" &&
			part.type === "text" &&
			typeof part.text === "string"
		) {
			parts.push(part.text);
		}
	}
	return parts.length === 0 ? null : parts.join("\n");
}

function readUsage(message) {
	const u = message.usage;
	if (!u || typeof u !== "object") return undefined;
	const cost = u.cost && typeof u.cost === "object" ? u.cost : {};
	const input = number(u.input ?? u.input_tokens);
	const output = number(u.output ?? u.output_tokens);
	const cacheRead = number(u.cacheRead ?? u.cache_read_input_tokens);
	const cacheWrite = number(u.cacheWrite ?? u.cache_creation_input_tokens);
	const costInput = number(cost.input);
	const costOutput = number(cost.output);
	const costCacheRead = number(cost.cacheRead);
	const costCacheWrite = number(cost.cacheWrite);
	return {
		tokens: {
			input,
			output,
			cacheRead,
			cacheWrite,
			total: number(u.totalTokens) || input + output + cacheRead + cacheWrite,
		},
		cost: {
			input: costInput,
			output: costOutput,
			cacheRead: costCacheRead,
			cacheWrite: costCacheWrite,
			// Mirror the token total: fall back to the summed channel
			// costs when no explicit total is reported.
			total:
				number(cost.total ?? u.cost_usd) ||
				costInput + costOutput + costCacheRead + costCacheWrite,
		},
	};
}

function summarizeActivity(event) {
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

function toolAction(toolName) {
	if (toolName === "read" || toolName === "Read") return "reading";
	if (toolName === "verify_output") return "verifying output";
	return toolName;
}

function terminateChild(signal) {
	if (!child?.pid) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Child already exited.
		}
	}
}

function parentAlive() {
	if (!request.parentPid || request.parentPid === process.pid) return true;
	try {
		process.kill(request.parentPid, 0);
		return true;
	} catch {
		return false;
	}
}

function stateForClose(code) {
	if (stoppedBy) return stoppedBy;
	return code === 0 ? "complete" : "failed";
}

function fallbackExitCode(reason) {
	if (
		reason === "timeout" ||
		reason === "idle-timeout" ||
		reason === "output-limit" ||
		reason === "soft-deadline"
	)
		return 124;
	if (reason === "cancelled" || reason === "parent-exit") return 130;
	return 1;
}

function stopWarning(reason) {
	if (reason === "timeout")
		return `Pi subprocess timed out after ${request.timeoutMs}ms; sent SIGTERM.`;
	if (reason === "idle-timeout")
		return `Pi subprocess idle for ${request.idleTimeoutMs}ms; sent SIGTERM.`;
	if (reason === "output-limit")
		return "Pi subprocess exceeded reviewer output limits; sent SIGTERM.";
	if (reason === "soft-deadline")
		return (
			`Pi subprocess reached its soft deadline of ${request.softDeadlineMs}ms ` +
			`with ${request.timeoutMs}ms allowed in total; sent SIGTERM so the ` +
			"rest of the budget can be spent asking for its answer."
		);
	if (reason === "parent-exit")
		return "Pi parent process exited; sent SIGTERM.";
	return "Pi subprocess cancelled; sent SIGTERM.";
}

function lease(state) {
	return {
		schemaVersion: 1,
		runId: request.runId,
		reviewerId: request.reviewerId,
		state,
		parentPid: request.parentPid,
		supervisorPid: process.pid,
		// The same identity question asked about ourselves. Whoever finds
		// this lease later has to decide whether the process wearing our
		// pid is still us, and a pid alone cannot answer that.
		supervisorStartedAt,
		childPid: child?.pid ?? null,
		// So a reaper can tell our child from whatever inherited its pid
		// after we died. Its own process group, since the child is
		// spawned detached, which is what makes a group kill reach the
		// tools it started as well.
		childStartedAt,
		updatedAt: new Date().toISOString(),
	};
}

function progress(state, activity) {
	return {
		schemaVersion: 1,
		runId: request.runId,
		reviewerId: request.reviewerId,
		state,
		activity,
		elapsedMs: Date.now() - Date.parse(startedAt),
		idleMs: Date.now() - lastActivityAt,
		warningCount: warnings.length,
		updatedAt: new Date().toISOString(),
	};
}

async function appendRotating(path, chunk, options) {
	await mkdir(dirname(path), { recursive: true });
	const current = await size(path);
	if (current > 0 && current + chunk.byteLength > options.maxBytes) {
		await rotateCompressed(path, options.maxRotations);
	}
	await appendFile(path, chunk);
}

async function rotateCompressed(path, maxRotations) {
	for (let index = maxRotations; index >= 1; index--) {
		const current = rotationPath(path, index);
		const next = rotationPath(path, index + 1);
		if (!(await exists(current))) continue;
		if (index === maxRotations) {
			await rm(current, { force: true });
		} else {
			await rename(current, next);
		}
	}
	const first = rotationPath(path, 1);
	const source = `${path}.${process.pid}.${Date.now()}.rotate`;
	await rename(path, source);
	await gzipFile(source, first);
	await rm(source, { force: true });
}

async function gzipFile(source, destination) {
	const input = await readFile(source);
	const compressed = await gzipBuffer(input);
	await writeFile(destination, compressed);
}

function gzipBuffer(input) {
	return new Promise((resolve, reject) => {
		const gzip = createGzip();
		const chunks = [];
		gzip.on("data", (chunk) => chunks.push(chunk));
		gzip.once("error", reject);
		gzip.once("end", () => resolve(Buffer.concat(chunks)));
		gzip.end(input);
	});
}

function rotationPath(path, index) {
	return `${path}.${index}.gz`;
}

async function writeJsonAtomic(path, value) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, "\t")}\n`, "utf-8");
	await rename(tmp, path);
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function size(path) {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

function emit(event) {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

function warn(message) {
	if (warnings.length < (request.maxWarnings ?? 20)) warnings.push(message);
}

function number(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function truncateBytes(text, maxBytes) {
	// Reached once per delta now that a message is read while it is
	// still being written, so the common case must not measure. A
	// character is at most four bytes, so anything this short fits.
	if (text.length * 4 <= maxBytes) return text;
	if (Buffer.byteLength(text) <= maxBytes) return text;
	warn(`Reviewer assistant text exceeded ${maxBytes} bytes; truncated`);
	// Cut in the bytes and stepped back off a continuation byte, so a
	// multi-byte character is never split. Shortening by one character
	// and re-measuring the whole string is quadratic in the length.
	const held = Buffer.from(text, "utf8");
	let at = maxBytes;
	while (at > 0 && (held[at] & 0xc0) === 0x80) at--;
	return held.subarray(0, at).toString("utf8");
}

function truncate(text, max) {
	return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function tail(text, maxBytes) {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let start = text.length - 1;
	while (start > 0) {
		const candidate = text.slice(start);
		if (Buffer.byteLength(candidate) > maxBytes) return text.slice(start + 1);
		start--;
	}
	return text;
}

function trim(value, max) {
	const clean = String(value).replace(/\s+/g, " ").trim();
	return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

#!/usr/bin/env node

/**
 * The supervisor process: one per reviewer run, started detached by
 * runpi/supervisor.ts with the path of its request. It spawns pi,
 * watches its clocks, its cancel files and its parent, stops it when
 * one of them says so, and writes its lease, progress and result.
 * What the reviewer said is read by supervisor-transcript.mjs, what it
 * wrote beside its stream by supervisor-reads.mjs, how a stop is told
 * by supervisor-stops.mjs, and its files are written through
 * supervisor-files.mjs.
 *
 * Long because what is left is one process's state: the child, its
 * clocks, its stream and whether it went to a room are read and
 * changed by every handler here, and what reads none of it has already
 * gone to the modules above.
 */

import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { systemFacts } from "../../core/process/index.ts";
import {
	startTicksFromProc,
	tickedStanding,
} from "../../internal/process-ticks.ts";
import { noteOut, readParent, stillHanding } from "../handing.ts";
import { STDIO_GRACE_MS } from "./grace.mjs";
import {
	JOURNAL_PATH_VAR,
	JOURNAL_SAYS,
	journalFromStream,
} from "./journal.mjs";
import {
	appendRotating,
	exists,
	writeJsonAtomic,
} from "./supervisor-files.mjs";
import {
	discoverSessionPath,
	readJournal,
	verifiedEnvelope,
} from "./supervisor-reads.mjs";
import {
	fallbackExitCode,
	stateForClose,
	stopWarning,
} from "./supervisor-stops.mjs";
import { tail, truncate } from "./supervisor-text.mjs";
import { summarizeActivity, transcript } from "./supervisor-transcript.mjs";
import { handOver, wrapUpOwed, wrapUpRequest } from "./supervisor-wrap-up.mjs";
import { clockVerdict } from "./watchdog.mjs";

/** @typedef {import("../artifacts.ts").ReviewerTerminalState} TerminalState */
/** @typedef {import("./supervisor-stops.mjs").StopReason} StopReason */

const requestPath = process.argv[2];
if (!requestPath) {
	// biome-ignore lint/suspicious/noConsole: run by hand without its request, it can only say so on stderr.
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

const IDLE_DEFAULT_MS = 15 * 60 * 1000;

if (typeof request.timeoutMs !== "number") {
	request.timeoutMs = TIMEOUT_DEFAULT_MS;
}
if (typeof request.idleTimeoutMs !== "number") {
	request.idleTimeoutMs = IDLE_DEFAULT_MS;
}
const startedAt = new Date().toISOString();
/** @type {string[]} */
const warnings = [];
// What the reviewer said, spent and verified, as its stream tells it.
const said = transcript({
	maxAssistantTextBytes: request.maxAssistantTextBytes,
	warn,
});
let stderrTail = "";
let stdoutBuffer = "";
let discardingOversizedLine = false;
/** @type {import("node:child_process").ChildProcess | null} */
let child = null;
/** @type {StopReason | null} */
let stoppedBy = null;
let settled = false;
let lastActivityAt = Date.now();
/** @type {NodeJS.Timeout | null} */
let killTimer = null;
/** @type {NodeJS.Timeout | null} */
let heartbeatTimer = null;
/** @type {NodeJS.Timeout | null} */
let watchdogTimer = null;
/** @type {number | null} */
let childStartedAt = null;
/** @type {number | null} */
let childStartTicks = null;
// Asked of the reader that will check it, not taken off our own clock.
// Whoever finds this lease compares it with what ps says about our pid,
// and ps says whole seconds, built on Linux from a boot time that is
// whole seconds too. Our clock read here is after node has booted, so
// the two could sit two seconds apart, past the tolerance, and a live
// supervisor then read as gone: a watcher told the model to collect
// from under running reviewers and nothing refused. Read the same way
// by both sides, the truncation is the same on both. Our own clock only
// where ps cannot answer, which is where the reader falls back to the
// heartbeat anyway.
const supervisorStartedAt =
	(await systemFacts.startedAt(process.pid)) ?? Date.now();
// Our start, and our child's, in the kernel's ticks since boot, and
// which boot: the milliseconds above move with every suspend, and a
// reader judges by these where they are kept (lib/subagent/lease.ts).
const supervisorStartTicks = (await startTicksFromProc(process.pid)) ?? null;
const bootId = systemFacts.bootId?.() ?? null;
/** @type {NodeJS.Timeout | null} */
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

// Before anything is awaited, because the child is spawned into its own
// process group and this process is the only thing that will ever stop
// it. A signal taken by default ends us and leaves the child running,
// and that used to be possible in two places: in the writes between the
// spawn and handlers installed after it, and on any second signal, since
// the handlers were once-only and a second SIGTERM during the kill grace
// ended the process that was holding the SIGKILL. A hangup had no
// handler at all, and on the waiting path we share the session's group,
// so closing the terminal left every running reviewer behind.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
	process.on(signal, () => {
		// A fleet handed on as its session moved outlives the window it
		// was started in, and the window closing hangs up on the group
		// we share with it; who we answer to now is parent.json's to say.
		if (signal === "SIGHUP" && readParent(request.paths.runDir)) return;
		stopChild("cancelled");
	});
}
// The same orphaning by another road. A waiting parent reads our
// stdout, and once it has gone the next line meets a closed pipe: an
// EPIPE nobody listens for is thrown, and the supervisor dies in the
// middle of the run it is there to finish. Stdout was only ever a
// convenience, since the files are the contract, so a reader that
// went away just stops being written to. Whether the parent itself is
// gone is the parent watchdog's question, not this one's.
let reporting = true;
process.stdout.on("error", () => {
	reporting = false;
});

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

// Stopped while still getting ready, by a signal or by a cancellation
// written before we started: a run's later reviewers are prepared while
// its earlier ones run. Starting a pi only to kill it would get as far
// as its first request before the watchdog noticed.
if (
	(await exists(request.paths.cancelPath)) ||
	(await exists(request.runCancelPath))
)
	stopChild("cancelled");
if (stoppedBy !== null) await finish(stoppedBy, fallbackExitCode(stoppedBy));

const childEnv = {
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
};

// A reviewer asked to run on a room goes there first, and here only
// when the room gave nothing back (lib/subagent/runpi/room-launch.ts).
// Its journal is written into a home that ends with its session, so
// what it recorded is read off its stream and written here instead.
/** @type {{ binary: string, args: string[] } | undefined} */
let room = request.room;
/** When the clocks run from: the start, or the start here after a room gave nothing. */
let clockFrom = Date.parse(startedAt);
const roomJournal = room === undefined ? undefined : journalFromStream();
let streamedBytes = 0;
if (request.roomStays)
	warn(`This reviewer ran here, not on a room: ${request.roomStays}.`);
await launch(room ?? request);

/**
 * Start the reviewer, here or on a room, and listen to it.
 *
 * @param {{ binary: string, args: string[] }} given
 */
async function launch(given) {
	/** @type {import("node:child_process").ChildProcess} */
	let self;
	try {
		// The room's command starts in this run's own folder, with PATH's
		// absolute folders only, so nothing it runs by a bare name comes
		// from the tree under review.
		self = spawn(given.binary, given.args, {
			cwd: given === room ? dirname(request.paths.leasePath) : request.cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: given === room ? roomEnv(childEnv) : childEnv,
		});
	} catch (error) {
		// spawn throws, rather than emitting "error", for arguments the
		// kernel refuses outright, such as a room's brief past ARG_MAX.
		const message = error instanceof Error ? error.message : String(error);
		if (await fellBack(message)) return;
		warnings.push(`Supervisor failed to spawn reviewer: ${message}`);
		await finish("failed", 1);
		return;
	}
	child = self;
	childStartTicks = null;

	// The moment the child came into being, to the nearest millisecond
	// this process can observe. Recorded because a pid on its own does
	// not identify anything: the operating system reuses them, and
	// whoever finds this lease after we are gone is about to decide
	// whether to kill what it names. A process started before we spawned
	// ours is not ours.
	//
	// Not asked of ps, unlike our own stamp: that would put an await
	// between the spawn and the listeners below, and an exit in it would
	// be missed. Taken now it is within milliseconds of the true start,
	// and the rare reading that misses the tolerance calls the child a
	// stranger, so a reaper declines to kill it: the safe way to be wrong.
	childStartedAt = Date.now();

	// Ahead of the writes below: a command that isn't there says so on
	// the next tick, and an "error" with no listener yet would take this
	// supervisor down rather than run the reviewer here. It waits for
	// those writes, so a reviewer started here doesn't write the same
	// files beside them.
	/** @type {() => void} */
	let wrote = () => undefined;
	const written = new Promise((resolve) => {
		wrote = () => resolve(undefined);
	});
	self.once("error", async (error) => {
		await written;
		if (child !== self || (await fellBack(error.message))) return;
		warnings.push(`Supervisor failed to spawn reviewer: ${error.message}`);
		await finish("failed", 1);
	});

	emit({
		type: "started",
		runId: request.runId,
		reviewerId: request.reviewerId,
		pid: self.pid ?? 0,
		pgid: self.pid ?? undefined,
	});
	try {
		await writeJsonAtomic(request.paths.leasePath, lease("running"));
		await writeJsonAtomic(
			request.paths.progressPath,
			progress("running", "spawned reviewer"),
		);
	} finally {
		wrote();
	}

	// A room child replaced by a local one may still have bytes in its
	// pipes; they belong to nobody's run now.
	self.stdout?.on("data", (chunk) => {
		if (child !== self) return;
		streamedBytes += chunk.length;
		stdoutTask = stdoutTask.then(() => handleStdout(chunk));
	});
	self.stderr?.on("data", (chunk) => {
		if (child !== self) return;
		stderrTask = stderrTask.then(() => handleStderr(chunk));
	});
	self.once("close", async (code) => {
		// A spawn that failed closes too, a few turns after its "error";
		// it waits for the same writes before anything starts here.
		await written;
		if (settled || child !== self) return;
		// A room that ended cleanly having said nothing ran no review either.
		if (await fellBack(`it ended ${code}`)) return;
		await finish(
			stateForClose(stoppedBy, code),
			code ?? fallbackExitCode(stoppedBy),
		);
	});
	// The child's ticks, read once its listeners are in and not awaited,
	// so nothing new stands between them and an early exit. The next
	// lease the heartbeat writes carries them; until then, and for a
	// child gone by now, its milliseconds decide.
	if (self.pid) {
		const childPid = self.pid;
		void startTicksFromProc(childPid).then((ticks) => {
			if (child === self) childStartTicks = ticks ?? null;
		});
	}
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
	self.once("exit", (code) => {
		// The answer of last resort is about a child that never exited, so
		// seeing one exit is the end of its question. Left armed, it fires
		// mid-drain and says "it may not have started at all" about a
		// reviewer that provably started and stopped, which is a false
		// diagnosis aimed at whoever reads the round next.
		//
		// It also decided how long the drain really got. The two rungs were
		// independent, so the drain owned the rest of the shutdown only
		// while it was shorter than the kill grace, and nothing said so:
		// two seconds against a five second grace won by three, and the
		// same drain against a stop that shortened the grace to 500ms was
		// cut to a fifth of its nominal value with no warning. Cleared
		// here, the drain is the drain whatever the grace was.
		if (reportTimer !== null) clearTimeout(reportTimer);
		reportTimer = null;
		const grace = setTimeout(async () => {
			if (settled || child !== self) return;
			if (await fellBack(`it ended ${code}`)) return;
			warnings.push(
				"Reviewer exited but left its output open; something it " +
					"started is still holding the pipes. Finished without them.",
			);
			void finish(
				stateForClose(stoppedBy, code),
				code ?? fallbackExitCode(stoppedBy),
			);
		}, STDIO_GRACE_MS);
		grace.unref?.();
	});
}

/**
 * Start the reviewer here instead, when the room it was asked on gave
 * nothing back: no machine took it, the entry refused it, or its
 * checkout failed. A room reviewer that said anything at all, or that
 * one of our own clocks stopped, is reported as it ended, since
 * starting it again here would pay for the same review twice.
 *
 * @param {string} why
 */
async function fellBack(why) {
	if (room === undefined || stoppedBy !== null || streamedBytes > 0)
		return false;
	room = undefined;
	// Whatever the room's command left behind goes with it, so nothing of
	// it holds pipes or a slot beside the reviewer that runs here.
	const gone = child?.pid;
	if (gone !== undefined) {
		try {
			process.kill(-gone, "SIGKILL");
		} catch {
			// Its group is already gone, which is what was wanted.
		}
	}
	// Its last words may still be queued, and they say why it gave nothing.
	await stderrTask;
	warn(
		`No room ran this reviewer (${why}: ${truncate(stderrTail.trim(), 200)}); it ran here instead.`,
	);
	stderrTail = "";
	// The clocks start again for the reviewer that runs here, its soft
	// deadline among them, which a room can't hear.
	lastActivityAt = Date.now();
	clockFrom = Date.now();
	await launch(request);
	return true;
}

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

/** @param {Buffer} chunk */
async function handleStdout(chunk) {
	lastActivityAt = Date.now();
	await appendRotating(request.paths.eventsPath, chunk, {
		maxBytes: request.maxEventBytes,
		// The launcher always sends this. The fallback matches its default
		// so a request from an older launcher cannot quietly reintroduce
		// the ceiling that deleted the head of a long stream.
		maxRotations: request.maxEventRotations ?? 32,
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

/** @param {Buffer} chunk */
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

/** @param {string} line */
async function ingestLine(line) {
	if (discardingOversizedLine) {
		discardingOversizedLine = false;
		return;
	}
	const trimmed = line.trim();
	if (!trimmed) return;
	if (Buffer.byteLength(trimmed) > request.maxLineBytes) {
		if (said.skipped(trimmed)) warnSkipped();
		return;
	}
	let event;
	try {
		event = JSON.parse(trimmed);
	} catch {
		warn(`Malformed JSON event line: ${truncate(trimmed, 80)}`);
		return;
	}
	said.read(event);
	const recorded = room === undefined ? undefined : roomJournal?.read(event);
	if (recorded !== undefined && request.paths.journalPath) {
		try {
			await appendFile(request.paths.journalPath, recorded, "utf8");
		} catch (error) {
			warn(
				`A finding the room recorded wasn't kept: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
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
		if (said.skipped(stdoutBuffer)) warnSkipped();
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
		startedAtMs: clockFrom,
		timeoutMs: request.timeoutMs,
		softDeadlineMs: room === undefined ? request.softDeadlineMs : undefined,
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
	if (!(await parentAlive())) stopChild("parent-exit");
}

/** @param {StopReason} reason */
function stopChild(reason) {
	if (stoppedBy !== null || settled) return;
	stoppedBy = reason;
	warn(stopWarning(reason, request));
	// Nothing to stop yet: the spawn sees the reason and never starts one.
	if (child === null) return;
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

/**
 * @param {TerminalState} state
 * @param {number} exitCode
 */
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
	said.adopt(await verifiedEnvelope(request.paths?.verifiedOutputPath, warn));
	const journalled = await readJournal(request.paths?.journalPath, warn);
	// Reported to the round separately as well as warned about here,
	// because the round replaces a participant's warnings with its own
	// sentence and these say findings were dropped, which is the one
	// thing that must not travel in a channel nobody reads.
	const journalTrouble = warnings.filter((warning) =>
		warning.startsWith(JOURNAL_SAYS),
	);
	const sessionPath = await discoverSessionPath(request.paths?.sessionDir);
	// A reviewer's final turn can end on a provider or
	// transport error while the child still exits 0. Report
	// that honestly: the run is "errored", not "complete",
	// and the structured error travels on the result so the
	// parent can classify it and decide whether to resume.
	const error = said.error(state);
	const reportedState = error && state === "complete" ? "errored" : state;
	const completedAt = new Date().toISOString();
	const answer = said.answer();
	await askForWrapUp(
		reportedState,
		sessionPath,
		answer.verification?.ok === true,
	);
	const result = {
		schemaVersion: 1,
		runId: request.runId,
		reviewerId: request.reviewerId,
		state: reportedState,
		exitCode,
		finalAssistantText: answer.text,
		...(journalled.length > 0 ? { journal: journalled } : {}),
		...(journalTrouble.length > 0 ? { journalWarnings: journalTrouble } : {}),
		usage: said.usage(),
		sessionIds: said.sessionIds,
		verification: answer.verification,
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

/** @param {NodeJS.Signals} signal */
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

/** When the hand-over's move note was last seen out, while handed on. */
/** @type {number | undefined} */
let noteSeenAt;

/**
 * Whether whoever this run answers to is still there: the conversation
 * that took a handed-on fleet up, a hand-over still under way
 * (lib/subagent/handing.ts), or else the parent the request named.
 */
async function parentAlive() {
	const parent = readParent(request.paths.runDir);
	if (parent && "owner" in parent) {
		return (await tickedStanding(parent.owner)) !== "gone";
	}
	if (parent) {
		const now = Date.now();
		if (noteOut(parent.handing.note)) noteSeenAt = now;
		return stillHanding(parent.handing, now, noteSeenAt);
	}
	if (request.parentOwner) {
		return (await tickedStanding(request.parentOwner)) !== "gone";
	}
	if (!request.parentPid || request.parentPid === process.pid) return true;
	try {
		process.kill(request.parentPid, 0);
		return true;
	} catch {
		return false;
	}
}

/** @param {string} state */
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
		supervisorStartTicks,
		childStartTicks,
		bootId,
		updatedAt: new Date().toISOString(),
	};
}

/**
 * @param {string} state
 * @param {string} activity
 */
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

/** @param {Record<string, unknown>} event */
function emit(event) {
	if (!reporting) return;
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * Ask a reviewer nobody waits for, which a clock stopped, for what it
 * had: its wrap-up's supervisor is started before this run's result is
 * written, so a collect holds the round until the answer is in.
 *
 * @param {string} state
 * @param {string | undefined} sessionPath
 * @param {boolean} verified
 */
async function askForWrapUp(state, sessionPath, verified) {
	const asked = wrapUpRequest(request, state, sessionPath, verified);
	if (asked === undefined) {
		if (wrapUpOwed(request, state, verified))
			warn(
				"This stopped reviewer was owed a wrap-up, but left no session to resume it on, so it was not asked.",
			);
		return;
	}
	try {
		await handOver(asked, fileURLToPath(import.meta.url));
		warn(
			`Handed this stopped reviewer's wrap-up to a supervisor of its own, as ${asked.reviewerId}.`,
		);
	} catch (error) {
		// Asking is an extra: failing to ask costs a warning, and what the
		// reviewer had already written is kept.
		warn(
			`Could not ask this stopped reviewer for its findings: ${
				error instanceof Error ? error.message : String(error)
			}. What it had already written is kept.`,
		);
	}
}

/**
 * The environment the room's command starts with: the reviewer's, with
 * PATH cut to its absolute folders, so a relative one can't name a
 * program in the folder it starts from.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function roomEnv(env) {
	const path = (env.PATH ?? "")
		.split(":")
		.filter((dir) => isAbsolute(dir))
		.join(":");
	return { ...env, PATH: path };
}

function warnSkipped() {
	warn(`Reviewer stream line exceeded ${request.maxLineBytes} bytes; skipped`);
}

/** @param {string} message */
function warn(message) {
	if (warnings.length < (request.maxWarnings ?? 20)) warnings.push(message);
}

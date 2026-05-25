#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
	appendFile,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { createGzip } from "node:zlib";

const requestPath = process.argv[2];
if (!requestPath) {
	console.error("Usage: reviewer-supervisor.mjs <request.json>");
	process.exit(2);
}

const request = JSON.parse(await readFile(requestPath, "utf-8"));
const startedAt = new Date().toISOString();
const warnings = [];
let finalAssistantText = "";
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
let stdoutTask = Promise.resolve();
let stderrTask = Promise.resolve();

await mkdir(request.paths.reviewerDir, { recursive: true });
await writeJsonAtomic(request.paths.leasePath, lease("starting"));
await writeJsonAtomic(request.paths.progressPath, progress("pending", ""));

child = spawn(request.binary, request.args, {
	cwd: request.cwd,
	detached: true,
	stdio: ["ignore", "pipe", "pipe"],
	env: {
		...process.env,
		PR_WORKFLOW_RUN_ID: request.runId,
		PR_WORKFLOW_REVIEWER_ID: request.reviewerId,
		PR_WORKFLOW_SUPERVISOR: "1",
	},
});

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

heartbeatTimer = setInterval(() => {
	void writeJsonAtomic(request.paths.leasePath, lease("running"));
}, request.heartbeatMs ?? 1000);
heartbeatTimer.unref?.();

watchdogTimer = setInterval(() => {
	void checkWatchdogs();
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

async function checkWatchdogs() {
	if (settled) return;
	if (
		(await exists(request.paths.cancelPath)) ||
		(await exists(request.runCancelPath))
	) {
		stopChild("cancelled");
		return;
	}
	if (!parentAlive()) {
		stopChild("parent-exit");
		return;
	}
	const elapsed = Date.now() - Date.parse(startedAt);
	if (elapsed > request.timeoutMs) {
		stopChild("timeout");
		return;
	}
	if (Date.now() - lastActivityAt > request.idleTimeoutMs) {
		stopChild("idle-timeout");
	}
}

function stopChild(reason) {
	if (stoppedBy !== null || settled) return;
	stoppedBy = reason;
	warn(stopWarning(reason));
	terminateChild("SIGTERM");
	killTimer = setTimeout(() => terminateChild("SIGKILL"), request.killGraceMs);
	killTimer.unref?.();
}

async function finish(state, exitCode) {
	if (settled) return;
	settled = true;
	if (heartbeatTimer) clearInterval(heartbeatTimer);
	if (watchdogTimer) clearInterval(watchdogTimer);
	if (killTimer) clearTimeout(killTimer);
	await Promise.allSettled([stdoutTask, stderrTask]);
	if (stdoutBuffer.length > 0 && !discardingOversizedLine)
		await ingestLine(stdoutBuffer);
	stdoutBuffer = "";
	const completedAt = new Date().toISOString();
	const result = {
		schemaVersion: 1,
		runId: request.runId,
		reviewerId: request.reviewerId,
		state,
		exitCode,
		finalAssistantText: canonicalVerifiedText() ?? finalAssistantText,
		usage,
		verification,
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
	process.exit(0);
}

function captureAssistantMessage(event) {
	const message = assistantMessage(event);
	if (!message) return;
	const text = textContent(message);
	if (text !== null)
		finalAssistantText = truncateBytes(text, request.maxAssistantTextBytes);
	const nextUsage = readUsage(message);
	if (nextUsage !== undefined) usage = nextUsage;
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
	verification = {
		called: true,
		ok,
		...(typeof args.stage === "string" ? { stage: args.stage } : {}),
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

function canonicalVerifiedText() {
	if (!verification?.ok || !("output" in verification)) return null;
	return JSON.stringify(verification.output, null, 2);
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

function assistantMessage(event) {
	if (typeof event !== "object" || event === null) return null;
	if (event.type !== "message_end") return null;
	const message = event.message;
	if (typeof message !== "object" || message === null) return null;
	return message.role === "assistant" ? message : null;
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
	return {
		tokens: {
			input,
			output,
			cacheRead,
			cacheWrite,
			total: number(u.totalTokens) || input + output + cacheRead + cacheWrite,
		},
		cost: {
			input: number(cost.input),
			output: number(cost.output),
			cacheRead: number(cost.cacheRead),
			cacheWrite: number(cost.cacheWrite),
			total: number(cost.total ?? u.cost_usd),
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
		reason === "output-limit"
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
		childPid: child?.pid ?? null,
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
	if (Buffer.byteLength(text) <= maxBytes) return text;
	warn(`Reviewer assistant text exceeded ${maxBytes} bytes; truncated`);
	let end = text.length;
	while (end > 0) {
		const candidate = text.slice(0, end);
		if (Buffer.byteLength(candidate) <= maxBytes) return candidate;
		end--;
	}
	return "";
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

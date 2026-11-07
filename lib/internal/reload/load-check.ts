/**
 * Whether a checkout of a pi package loads, asked of pi itself.
 *
 * pi in RPC mode loads every extension it is given, answers commands
 * without a model, and exits with 1 naming each extension that failed
 * to load. So the check starts pi with nothing but the package
 * (`--no-extensions` turns off everything configured, built-ins
 * included, and `-e` adds the one package back), asks for its
 * commands, and closes stdin, which is pi's orderly shutdown. Thirteen
 * seconds for this whole package, with no model and no network.
 *
 * It catches what nothing static can: a dependency the install does
 * not hold, an export a dependency no longer has, a flag two
 * extensions both register, a module that throws while it loads.
 *
 * Every extension starts up in that pi, so it runs in a sandbox of its
 * own, as the tests do: the code under check is often unmerged, and on
 * 7 November one check rewrote the launcher's list of quests from a
 * branch a minute before it merged.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_ONLY_VARIABLES } from "../../core/internal/terminal/drivers/shared.ts";

/**
 * What ties a process to this session, its holder, its terminal or the
 * desktop, beyond the variables a terminal it opens leaves out.
 */
const MACHINE_TIES = ["NIRI_SOCKET", "WAYLAND_DISPLAY", "DISPLAY"];

/**
 * The environment the checking pi starts with: the parent's, with its
 * own state, data, cache and runtime folders under `sandbox`, nothing
 * that reaches the person (notifications, the launcher), and none of
 * the variables that tie a process to a session, its holder, its
 * terminal or the desktop. Configuration stays the person's, since
 * what loads may depend on it, and the check only reads it.
 */
export function loadCheckEnvironment(
	parent: Readonly<Record<string, string | undefined>>,
	sandbox: string,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(parent)) {
		if (value === undefined) continue;
		if (SESSION_ONLY_VARIABLES.includes(key) || MACHINE_TIES.includes(key)) {
			continue;
		}
		if (key.startsWith("MYCELIUM_")) continue;
		env[key] = value;
	}
	return {
		...env,
		XDG_STATE_HOME: join(sandbox, "state"),
		XDG_DATA_HOME: join(sandbox, "data"),
		XDG_CACHE_HOME: join(sandbox, "cache"),
		XDG_RUNTIME_DIR: join(sandbox, "runtime"),
		PI_NOTIFY: "off",
		PI_LAUNCHER: "off",
		PI_SETTLE: "off",
		PI_OFFLINE: "1",
	};
}

/** One extension pi could not load, and what it said about it. */
export interface LoadFailure {
	/** The extension's entry file, as pi named it. */
	readonly extension: string;
	/** The first line of pi's error, which carries the cause. */
	readonly error: string;
}

/** What pi said when it was asked to load a package. */
export interface LoadReport {
	/** Loaded with no failure, and answered the way a live pi answers. */
	readonly ok: boolean;
	readonly failures: readonly LoadFailure[];
	/** How many commands the package registered, when pi got far enough to say. */
	readonly commands?: number;
	/** Why the check could not decide, when it could not: pi would not start, hung, or answered nothing. */
	readonly problem?: string;
}

/** The pi to start: its node binary, entry script and asset dir. */
export interface PiToRun {
	readonly node: string;
	readonly entry: string;
	/** `PI_PACKAGE_DIR`, when the parent pi was started with one. */
	readonly packageDir?: string;
}

/** How long a load may take before it counts as hung. */
export const LOAD_TIMEOUT_MS = 90_000;

/** The arguments that make pi load one package and nothing else. */
export function loadCheckArgs(packageRoot: string): string[] {
	return [
		"--mode",
		"rpc",
		"--no-session",
		"--offline",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--extension",
		packageRoot,
	];
}

/** The request the check sends: list the commands, which needs no model. */
const ASK_COMMANDS = `${JSON.stringify({ id: "load-check", type: "get_commands" })}\n`;

/** How pi opens each extension's load failure on stderr. */
const FAILURE = /^Error: Failed to load extension "([^"]+)": (.*)$/;

/** The prefix pi repeats inside the message, which says nothing new. */
const REPEATED_PREFIX = /^Failed to load extension: /;

/** The failures pi wrote to stderr, in the order it wrote them. */
export function loadFailures(stderr: string): LoadFailure[] {
	const failures: LoadFailure[] = [];
	for (const line of stderr.split("\n")) {
		const match = FAILURE.exec(line.trim());
		if (!match) continue;
		const [, extension = "", error = ""] = match;
		failures.push({ extension, error: error.replace(REPEATED_PREFIX, "") });
	}
	return failures;
}

/** The number of commands in pi's answer to `get_commands`, if it gave one. */
function commandCount(stdout: string): number | undefined {
	for (const line of stdout.split("\n")) {
		if (!line.includes('"load-check"')) continue;
		try {
			const record: unknown = JSON.parse(line);
			if (typeof record !== "object" || record === null) continue;
			if (!("success" in record) || record.success !== true) continue;
			if (!("data" in record)) continue;
			const data = record.data;
			if (typeof data !== "object" || data === null) continue;
			if (!("commands" in data) || !Array.isArray(data.commands)) continue;
			return data.commands.length;
		} catch {
			// A line that is not a whole record is not the answer.
		}
	}
	return undefined;
}

/** What pi's output says about the load, read without running anything. */
export function readLoad(
	stdout: string,
	stderr: string,
	exitCode: number | null,
): LoadReport {
	const failures = loadFailures(stderr);
	const commands = commandCount(stdout);
	const counted = commands === undefined ? {} : { commands };
	if (failures.length > 0) return { ok: false, failures, ...counted };
	if (exitCode !== 0) {
		const said = stderr.trim().split("\n")[0] ?? "";
		return {
			ok: false,
			failures,
			...counted,
			problem: `pi exited with ${exitCode ?? "a signal"}${said ? `: ${said}` : ""}`,
		};
	}
	if (commands === undefined) {
		return { ok: false, failures, problem: "pi never answered" };
	}
	return { ok: true, failures, commands };
}

/** Load `packageRoot` in a pi of its own and report what happened. */
export function checkLoad(
	pi: PiToRun,
	packageRoot: string,
	timeoutMs = LOAD_TIMEOUT_MS,
): Promise<LoadReport> {
	return new Promise((resolve) => {
		const sandbox = mkdtempSync(join(tmpdir(), "load-check-sandbox-"));
		const env: NodeJS.ProcessEnv = loadCheckEnvironment(process.env, sandbox);
		if (pi.packageDir) env.PI_PACKAGE_DIR = pi.packageDir;
		const settle = (report: LoadReport) => {
			rmSync(sandbox, { recursive: true, force: true });
			resolve(report);
		};
		// A directory with no project settings or context files of its own,
		// so the load is the package's and nothing the cwd adds.
		const child = spawn(pi.node, [pi.entry, ...loadCheckArgs(packageRoot)], {
			cwd: tmpdir(),
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let hung = false;
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => {
			hung = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			settle({
				ok: false,
				failures: [],
				problem: `pi would not start: ${error.message}`,
			});
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (hung) {
				settle({
					ok: false,
					failures: loadFailures(stderr),
					problem: `pi was still loading after ${Math.ceil(timeoutMs / 1000)}s`,
				});
				return;
			}
			settle(readLoad(stdout, stderr, code));
		});
		child.stdin.on("error", () => {
			// pi exited before reading its request; close says why.
		});
		child.stdin.end(ASK_COMMANDS);
	});
}

/** The report as lines a person or a model reads. */
export function describeLoad(report: LoadReport, packageRoot: string): string {
	if (report.ok) {
		return `${packageRoot} loads: ${report.commands} commands registered, no extension failed.`;
	}
	const lines = [`${packageRoot} does not load.`];
	if (report.problem) lines.push(report.problem);
	for (const failure of report.failures) {
		lines.push(`- ${failure.extension}: ${failure.error}`);
	}
	return lines.join("\n");
}

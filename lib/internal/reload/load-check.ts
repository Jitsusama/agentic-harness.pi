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
 */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

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
		const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: "1" };
		if (pi.packageDir) env.PI_PACKAGE_DIR = pi.packageDir;
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
			resolve({
				ok: false,
				failures: [],
				problem: `pi would not start: ${error.message}`,
			});
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (hung) {
				resolve({
					ok: false,
					failures: loadFailures(stderr),
					problem: `pi was still loading after ${Math.ceil(timeoutMs / 1000)}s`,
				});
				return;
			}
			resolve(readLoad(stdout, stderr, code));
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

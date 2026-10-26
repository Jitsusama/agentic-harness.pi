/**
 * Zellij driver, through `zellij --session <name> action`.
 *
 * A zellij session is reachable by name from anywhere on the host, so
 * the session name is the scope and a pane's `terminal_<n>` id is the
 * value. Zellij is a multiplexer: it opens tabs and panes inside the
 * terminal that shows it, and cannot make a desktop window.
 */

import { hostname } from "node:os";
import {
	type TerminalDriver,
	type TerminalLivenessCapability,
	type TerminalProbe,
	type TerminalRequest,
	type TerminalSessionHandle,
	type TerminalSighting,
	type TerminalTypeCapability,
	terminalHandleKey,
} from "../../../../terminal/types.ts";
import { locateBinary } from "../binaries.ts";
import { runCli, TERMINAL_CLI_TIMEOUT_MS } from "../cli.ts";
import {
	PROMPT_WAIT_MS,
	untilPromptShown,
	wrapCommandWithEnv,
} from "./shared.ts";

/** The handle kind zellij's panes are recorded under. */
export const ZELLIJ_HANDLE_KIND = "zellij-pane";

/** How many times a new tab's listing is read while its pane appears. */
const TAB_PANE_ATTEMPTS = 10;

/** How long to wait between those reads. */
const TAB_PANE_POLL_MS = 100;

/** One pane in a `list-panes --json --tab` listing, as far as it is read. */
interface ZellijPane {
	readonly id?: unknown;
	readonly is_plugin?: unknown;
	readonly tab_id?: unknown;
}

/** A zellij pane id in the `terminal_<n>` form every action accepts. */
export function zellijPaneId(raw: string | number): string {
	const text = String(raw);
	return /^\d+$/.test(text) ? `terminal_${text}` : text;
}

/** The terminal pane ids in a `list-panes --json` listing, optionally in one tab. */
export function zellijTerminalPanes(
	listing: unknown,
	tabId?: string,
): string[] {
	if (!Array.isArray(listing)) return [];
	const out: string[] = [];
	for (const pane of listing as ZellijPane[]) {
		if (pane.is_plugin !== false || typeof pane.id !== "number") continue;
		if (tabId !== undefined && String(pane.tab_id) !== tabId) continue;
		out.push(zellijPaneId(pane.id));
	}
	return out;
}

/** The `action` arguments that open a request's surface. */
export function zellijActionArgs(
	request: TerminalRequest,
	shell = "/bin/sh",
): string[] {
	const args =
		request.layout === "pane" ? ["action", "new-pane"] : ["action", "new-tab"];
	if (request.cwd) args.push("--cwd", request.cwd);
	if (request.title) args.push("--name", request.title);
	// No command means the person's own shell. Zellij 0.45 honours
	// --cwd only for a pane given a command, so with a directory to start
	// in the shell is named outright, as a login shell; on a terminal it
	// is interactive too, so every startup file runs.
	if (request.command === undefined) {
		if (request.cwd) args.push("--", shell, "-l");
		return args;
	}
	// Zellij hands a command its own environment, so variables meant for
	// it travel inside the command.
	args.push(
		"--",
		"/bin/sh",
		"-c",
		wrapCommandWithEnv(request.command, request.env),
	);
	return args;
}

/** What a zellij driver can be built with. */
export interface ZellijDriverOptions {
	/** How long one action may take. */
	readonly cliTimeoutMs?: number;
	/** How long typing waits for a new shell's prompt. */
	readonly promptWaitMs?: number;
	/** Where the session's environment is read from. */
	readonly env?: () => Readonly<Record<string, string | undefined>>;
}

/** A zellij driver whose actions end at the given clock. */
export function createZellijDriver(
	options: ZellijDriverOptions = {},
): TerminalDriver & TerminalLivenessCapability & TerminalTypeCapability {
	const timeout = options.cliTimeoutMs ?? TERMINAL_CLI_TIMEOUT_MS;
	const promptWait = options.promptWaitMs ?? PROMPT_WAIT_MS;
	const env = options.env ?? (() => process.env);
	const binary = (): string => locateBinary("zellij", "zellij") ?? "zellij";
	const run = (session: string, args: string[], input?: string) =>
		runCli(binary(), ["--session", session, ...args], {
			timeout,
			...(input !== undefined ? { input } : {}),
		});
	const listPanes = async (session: string): Promise<unknown> =>
		JSON.parse(await run(session, ["action", "list-panes", "--json", "--tab"]));

	const sight = (
		vars: Readonly<Record<string, string | undefined>>,
	): TerminalSighting | undefined => {
		const session = vars.ZELLIJ_SESSION_NAME;
		if (!session) return undefined;
		const pane = vars.ZELLIJ_PANE_ID;
		return {
			driverId: "zellij",
			...(pane
				? {
						handle: {
							driverId: "zellij",
							kind: ZELLIJ_HANDLE_KIND,
							hostId: hostname(),
							scope: session,
							value: zellijPaneId(pane),
						},
					}
				: {}),
			reachable: true,
			source: "environment",
		};
	};

	return {
		id: "zellij",
		kind: "multiplexer",
		binary: "zellij",
		programs: ["zellij"],
		layouts: {
			tab: "a tab (action new-tab)",
			pane: "a pane (action new-pane)",
		},
		available() {
			return locateBinary("zellij", "zellij") !== undefined;
		},
		sight,
		async spawn(request) {
			const session = request.near?.scope ?? env().ZELLIJ_SESSION_NAME;
			if (!session) {
				throw new Error(
					"zellij has no session to open into: this pi is not inside zellij",
				);
			}
			const printed = (
				await run(session, zellijActionArgs(request, env().SHELL))
			).trim();
			const handle = (value: string): TerminalSessionHandle => ({
				driverId: "zellij",
				kind: ZELLIJ_HANDLE_KIND,
				hostId: hostname(),
				scope: session,
				value,
			});
			if (request.layout === "pane") {
				return /^terminal_\d+$/.test(printed) ? handle(printed) : undefined;
			}
			// A new tab prints its tab id; its pane shows up in the listing
			// once zellij has started it.
			if (!/^\d+$/.test(printed)) return undefined;
			for (let attempt = 0; attempt < TAB_PANE_ATTEMPTS; attempt++) {
				const [pane] = zellijTerminalPanes(await listPanes(session), printed);
				if (pane) return handle(pane);
				await new Promise((resolve) => setTimeout(resolve, TAB_PANE_POLL_MS));
			}
			return undefined;
		},
		async typeInto(handle, text) {
			if (!handle.scope) {
				throw new Error(
					"this zellij pane was recorded without its session, so nothing can reach it",
				);
			}
			const session = handle.scope;
			await untilPromptShown(
				() =>
					run(session, ["action", "dump-screen", "--pane-id", handle.value]),
				promptWait,
			);
			await run(session, [
				"action",
				"write-chars",
				"--pane-id",
				handle.value,
				text,
			]);
		},
		identifyCurrent() {
			return sight(env())?.handle;
		},
		async probe(handles, signal) {
			const sessions = new Set<string>();
			for (const handle of handles) {
				if (handle.scope && handle.hostId === hostname())
					sessions.add(handle.scope);
			}
			const live = new Map<string, Set<string> | undefined>();
			await Promise.all(
				[...sessions].map(async (session) => {
					if (signal?.aborted) return live.set(session, undefined);
					try {
						live.set(
							session,
							new Set(zellijTerminalPanes(await listPanes(session))),
						);
					} catch {
						// A session that has gone may yet be resurrected, and a
						// zellij that will not answer says nothing: unknown.
						live.set(session, undefined);
					}
				}),
			);
			const out = new Map<string, TerminalProbe>();
			for (const handle of handles) {
				const panes =
					handle.scope && handle.hostId === hostname()
						? live.get(handle.scope)
						: undefined;
				out.set(
					terminalHandleKey(handle),
					panes === undefined
						? "unknown"
						: panes.has(handle.value)
							? "present"
							: "absent",
				);
			}
			return out;
		},
	};
}

/** The zellij driver, on the default clock. */
export const zellij = createZellijDriver();

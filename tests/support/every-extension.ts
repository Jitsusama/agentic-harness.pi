/**
 * Load every extension of the package as pi does, into one process,
 * and say what that did to the process's listeners.
 *
 * Run in a child node of its own (see
 * tests/package/hosted-loads-add-no-process-listeners.test.ts), since a
 * listener once added stays for the life of the process and a
 * once-per-process marker another test set would hide one. Each
 * extension is loaded through jiti with its module cache off, as pi's
 * loader does, so each conversation gets its own module instances; its
 * factory runs and its `session_start` handlers fire inside that
 * conversation. pi is faked: what an extension registers is kept, and
 * anything else it calls answers nothing.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { installHost, withSession } from "../../lib/core/session/index.ts";
import { sessionHost } from "./session-host.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** What loading every extension did, for the parent to judge. */
export interface Loaded {
	/** How many extensions loaded. */
	readonly extensions: number;
	/** Listeners each process event gained, by event name. */
	readonly added: Record<string, number>;
	/** An extension whose load or start threw, with what it said. */
	readonly failed: readonly string[];
}

const ROOT = join(import.meta.dirname, "..", "..");

/** Where a host pins the pi its conversations' subagents run, before any load. */
const STARTUP_INSTALL_KEY = Symbol.for("pi.subagent.startupPiInstall");

/** pi's own rewrite of typebox's old name, which its loader applies. */
const ALIAS = {
	"@sinclair/typebox/value": "typebox/value",
	"@sinclair/typebox/compile": "typebox/compile",
	"@sinclair/typebox": "typebox",
};

/** Every extension pi finds under `./extensions`: a folder with an index.ts. */
function extensionEntries(): string[] {
	const dir = join(ROOT, "extensions");
	return readdirSync(dir)
		.map((name) => join(dir, name, "index.ts"))
		.filter((entry) => {
			try {
				return statSync(entry).isFile();
			} catch {
				// A folder with no entry is not an extension pi loads.
				return false;
			}
		})
		.sort();
}

/** The listener count of every event the process has listeners for. */
function listeners(): Map<string, number> {
	return new Map(
		process
			.eventNames()
			.map((name) => [String(name), process.listenerCount(name)] as const),
	);
}

/** Answers anything asked of it with nothing, so a call never throws. */
function nothing(): unknown {
	const answer: unknown = new Proxy(() => undefined, {
		get: (_target, key) => (key === "then" ? undefined : answer),
		apply: () => undefined,
	});
	return answer;
}

/** A fake pi for one runtime: registrations kept, the rest no-ops. */
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const known: Record<string, unknown> = {
		events: createEventBus(),
		on: (name: string, handler: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		getFlag: () => undefined,
		getActiveTools: () => [],
		getAllTools: () => [],
		getCommands: () => [],
		getMcpServers: () => [],
		getThinkingLevel: () => "off",
	};
	const pi = new Proxy(known, {
		get: (target, key) =>
			typeof key === "string" && key in target ? target[key] : () => undefined,
	});
	return { pi, handlers };
}

/** The context a conversation's hooks get, for conversation `id`. */
function contextFor(id: string, cwd: string): unknown {
	const known: Record<string, unknown> = {
		cwd,
		hasUI: false,
		isIdle: () => true,
		hasPendingMessages: () => false,
		signal: undefined,
		model: undefined,
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => undefined,
			getCwd: () => cwd,
			getEntries: () => [],
			getBranch: () => [],
			getHeader: () => undefined,
		},
		ui: nothing(),
	};
	return new Proxy(known, {
		get: (target, key) =>
			typeof key === "string" && key in target ? target[key] : nothing(),
	});
}

/**
 * Load and start every extension for conversations a and b under an
 * installed host when `hosted`, or for one conversation on plain pi.
 */
export async function loadEveryExtension(hosted: boolean): Promise<Loaded> {
	// pi's real folder, where pnpm keeps the jiti it loads extensions with.
	const pi = realpathSync(
		join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent"),
	);
	const { createJiti } = createRequire(join(pi, "package.json"))("jiti");
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		alias: ALIAS,
	});
	const entries = extensionEntries();
	const conversations = hosted ? ["a", "b"] : ["plain"];
	if (hosted) {
		(globalThis as Record<symbol, unknown>)[STARTUP_INSTALL_KEY] = {
			node: process.execPath,
			entry: join(pi, "dist", "bundle", "cli.js"),
		};
		installHost(sessionHost({ pid: process.pid, startedAt: Date.now() }).host);
	}
	const before = listeners();
	const failed: string[] = [];
	for (const id of conversations) {
		const { pi, handlers } = fakePi();
		for (const entry of entries) {
			const name = entry.split("/").at(-2) ?? entry;
			try {
				// The host loads a conversation's extensions inside it.
				await withSession(id, async () => {
					const factory = await jiti.import(entry, { default: true });
					await factory(pi);
				});
			} catch (error) {
				failed.push(`${name} (load): ${String(error)}`);
			}
		}
		const ctx = contextFor(id, process.cwd());
		for (const handler of handlers.get("session_start") ?? []) {
			try {
				await withSession(id, () =>
					handler({ type: "session_start", reason: "startup" }, ctx),
				);
			} catch (error) {
				failed.push(`session_start: ${String(error)}`);
			}
		}
	}
	const after = listeners();
	const added: Record<string, number> = {};
	for (const [name, count] of after) {
		const grown = count - (before.get(name) ?? 0);
		if (grown > 0) added[name] = grown;
	}
	return { extensions: entries.length, added, failed };
}

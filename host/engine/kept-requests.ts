/**
 * What a hosted conversation's requests need, kept past its park: the
 * environment and key each request sends, its agent folder, and what its
 * extensions registered of its providers. The host keeps a parked
 * conversation's cache warm on these once it has let its session go
 * (parked-warming.ts), and sends a refused request once more on a renewed
 * key.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { keepingRequests } from "../../extensions/compaction-workflow/kept-request.ts";
import { warmingSwitchedOn } from "../../extensions/compaction-workflow/warm.ts";
import {
	BUDGET_KEYS_VARIABLE,
	BUDGET_VARIABLE,
} from "../../lib/budget/record.ts";
import type { SessionEnvironment } from "../../lib/core/session/index.ts";
import type { RosterEntry } from "../../lib/core/session/roster.ts";
import { callIsOn } from "../../lib/internal/cache/calls.ts";
import {
	pendingWarmsDir,
	warmingCarryDir,
} from "../../lib/internal/cache/warming-carry.ts";
import { conversationAuthContext } from "./auth-context.ts";
import {
	AUTH_HEADER_VARIABLE,
	budgetKey,
	KEY_VARIABLES,
	laidKeys,
	unlistedKeys,
} from "./budget-keys.ts";
import type { EngineOptions } from "./contract.ts";
import {
	type KeptProviders,
	keptProviders,
	readKept,
	registerKept,
	writeKept,
} from "./kept-providers.ts";
import {
	type ParkedWarming,
	parkedWarming,
	warmThrough,
} from "./parked-warming.ts";
import type { ModelRuntime, PiSessions } from "./pi-session.ts";
import type { AssistantMessage } from "./pi-types.ts";
import { sessionEnvironment } from "./process-env.ts";

export { KEY_VARIABLES } from "./budget-keys.ts";

/** An answer the gateway gave a key it would not take. */
const REFUSED_KEY = /\b401\b/;

/** What its extensions registered of its providers, kept beside its store as it parks. */
const PROVIDERS_FILE = "providers.json";

/** What each conversation's requests need, and the warms sent on them while it parks. */
export interface KeptRequests {
	/** The host's warms of parked conversations. */
	readonly warming: ParkedWarming;
	/** The conversation's environment as one request sends it, the current key included. */
	requestEnv(sessionId: string): Promise<Readonly<Record<string, string>>>;
	/** Whether a refused request is worth sending again, having asked for a fresh key. */
	renewed(error: AssistantMessage, sessionId?: string): Promise<boolean>;
	/** pi builds the conversation's session on this agent folder, under the host's environment for it. */
	building(sessionId: string, agentDir: string): void;
	/** Keep what a parking conversation's extensions registered, for its warms here and in the next host. */
	keepProviders(sessionId: string, runtime: ModelRuntime): void;
	/** Take up what a conversation resting parked from an earlier host kept, and warm it. */
	restore(entry: RosterEntry): void;
	/** Let go of all a conversation's requests kept, once its warms have stopped. */
	forget(sessionId: string): void;
}

/** Keep each conversation's requests on its budget's key or the host's, warming each as it parks. */
export function keptRequests(options: {
	readonly engine: EngineOptions;
	readonly sessions: PiSessions;
	readonly report: (error: unknown) => void;
}): KeptRequests {
	const { engine, sessions, report } = options;
	const { host } = engine;
	// Each conversation's agent folder, where its model runtime reads auth and models.
	const agentDirs = new Map<string, string>();
	// Each conversation's environment, kept past its park: its warms go once the host has let it go.
	const environments = new Map<string, SessionEnvironment>();
	// What each conversation's extensions registered of its providers, kept past its park for its warms.
	const providers = new Map<string, KeptProviders>();
	const providersFile = (sessionId: string) =>
		join(engine.stateDir, sessionId, PROVIDERS_FILE);

	async function requestEnv(
		sessionId: string,
	): Promise<Readonly<Record<string, string>>> {
		// The runtime's own tools, as code in the host reads them, under
		// what the conversation names for itself.
		const values: Record<string, string> = { ...host.hostReads() };
		for (const [name, value] of Object.entries(
			environmentOf(sessionId).snapshot(),
		)) {
			if (value !== undefined) values[name] = value;
		}
		if (engine.key) {
			// A budget's key bills its budget; any other is the host's,
			// renewed, never a launch's that may have gone stale.
			sayUnlisted(sessionId, values);
			const header = laidKeys(values)[AUTH_HEADER_VARIABLE];
			if (header) values[AUTH_HEADER_VARIABLE] = header;
			else delete values[AUTH_HEADER_VARIABLE];
			const key = budgetKey(values) ?? (await engine.key.current());
			for (const name of KEY_VARIABLES) values[name] = key;
		}
		return values;
	}

	/** Whether a conversation's requests go on its budget's key, which the host can't renew. */
	function onBudgetKey(sessionId: string): boolean {
		return budgetKey(environmentOf(sessionId).snapshot()) !== undefined;
	}

	// The conversations already told their budget's key went unsent.
	const toldUnlisted = new Set<string>();

	/** Say once for a conversation when its budget holds a key it didn't list, which the host's replaces. */
	function sayUnlisted(
		sessionId: string,
		values: Readonly<Record<string, string>>,
	): void {
		if (toldUnlisted.has(sessionId)) return;
		const unlisted = unlistedKeys(values);
		if (unlisted.length === 0) return;
		toldUnlisted.add(sessionId);
		report(
			new Error(
				`Conversation ${sessionId} draws on budget ${values[BUDGET_VARIABLE]}, laid before budgets listed their keys in ${BUDGET_KEYS_VARIABLE}, so its ${unlisted.join(", ")} goes unsent and the host's key bills it until the budget is laid again.`,
			),
		);
	}

	/** A conversation's environment: the host's while it holds it, else the one it parked with. */
	function environmentOf(sessionId: string): SessionEnvironment {
		if (host.holds(sessionId) !== undefined) return host.env(sessionId);
		return environments.get(sessionId) ?? host.env(sessionId);
	}

	const warming = parkedWarming({
		carries: warmingCarryDir(),
		pending: pendingWarmsDir(),
		send: async (carry, signal) => {
			const agentDir = agentDirs.get(carry.sessionId);
			if (!agentDir)
				return { ok: false, reason: "its agent folder is unknown" };
			const runtime = await sessions.ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
				authContext: conversationAuthContext(() => requestEnv(carry.sessionId)),
			});
			const kept = providers.get(carry.sessionId);
			if (kept) registerKept(runtime, kept);
			return warmThrough(runtime, carry, signal);
		},
		enabled: async () => keepingRequests() && (await warmingSwitchedOn()),
		callOn: () => callIsOn({ missing: report }),
		held: (sessionId) =>
			report(
				`Parked warm of ${sessionId} held for a call until its entry expired`,
			),
		report,
	});

	return {
		warming,
		requestEnv,

		async renewed(error, sessionId) {
			const key = engine.key;
			if (!key || key.inherited || !REFUSED_KEY.test(error.errorMessage ?? ""))
				return false;
			// A refused budget key is the budget's to mend; the host's renewal sends the same one.
			if (sessionId !== undefined && onBudgetKey(sessionId)) return false;
			key.refused();
			return true;
		},

		building(sessionId, agentDir) {
			agentDirs.set(sessionId, agentDir);
			environments.set(sessionId, host.env(sessionId));
		},

		keepProviders(sessionId, runtime) {
			try {
				const kept = keptProviders(runtime);
				providers.set(sessionId, kept);
				writeKept(providersFile(sessionId), kept);
			} catch (error) {
				// Its park goes on: only its warms go without, failing as they say.
				report(error);
			}
		},

		// Its cache is kept warm as its park left it, on the folder and the
		// environment its start would give it, since no start comes to set them.
		restore(entry) {
			const { sessionId } = entry;
			agentDirs.set(sessionId, sessions.getAgentDir());
			const kept = readKept(providersFile(sessionId));
			if (kept) providers.set(sessionId, kept);
			environments.set(
				sessionId,
				sessionEnvironment(
					{ ...engine.env, ...(entry.launch ?? {}) },
					sessionId,
				),
			);
			warming.start(sessionId);
		},

		forget(sessionId) {
			agentDirs.delete(sessionId);
			environments.delete(sessionId);
			providers.delete(sessionId);
			toldUnlisted.delete(sessionId);
			rmSync(providersFile(sessionId), { force: true });
		},
	};
}

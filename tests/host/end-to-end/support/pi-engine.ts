/**
 * H1's engine as a sealed host runs it: createEngine on the pi built with
 * the host's patches, which PI_HOST_PACKAGE_DIR names, every conversation
 * loading this harness as its package, and the scripted model
 * (scripted-model.ts) registered in the host's own process, as the
 * engine's own tests do, and named in the seal's models.json, which a
 * plain pi opening a conversation's log reads too.
 *
 * A host process imports this by path, under node's own type stripping,
 * so it holds nothing node can't strip.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createEngine } from "../../../../host/engine/engine.ts";
import type { SessionHost } from "../../../../host/engine/session-host.ts";
import type { ConversationEngine } from "../../../../host/service/backend.ts";
import { conversationBase } from "../../../../host/service/program.ts";
import {
	fauxOf,
	SCRIPTED,
	SCRIPTED_API,
	SCRIPTED_MODELS,
	SCRIPTED_URL,
	scriptedCore,
} from "./scripted-model.ts";

/**
 * The harness every conversation loads: this tree, or the install
 * PI_HOST_TEST_HARNESS names, for a case about an install that moves.
 */
const HARNESS =
	process.env.PI_HOST_TEST_HARNESS ??
	resolve(import.meta.dirname, "../../../..");

/** What the module uses of pi-ai's registry of apis. */
interface Compat {
	registerApiProvider(provider: {
		api: string;
		stream: unknown;
		streamSimple: unknown;
	}): void;
}

/** A pi module as the engine module uses it: pi's JavaScript carries no types here. */
function piModule<T>(module: unknown): T {
	return module as T;
}

/** The seal's agent folder: the scripted model, the harness as a package, nothing retried. */
function writeAgentFolder(): void {
	const agentDir = join(homedir(), ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[SCRIPTED.provider]: {
					baseUrl: SCRIPTED_URL,
					api: SCRIPTED_API,
					apiKey: "$SHOPIFY_PROXY_KEY",
					models: SCRIPTED_MODELS,
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: SCRIPTED.provider,
			defaultModel: SCRIPTED.id,
			packages: [HARNESS],
			// The harness's codemode takes the built-in's place, as Joel's
			// settings say; without this, pi warns of it at every start.
			extensions: ["-builtin:codemode"],
			retry: { enabled: false },
			compaction: { enabled: false },
		}),
	);
}

/** Build H1's engine over a host's ownership, on the pi PI_HOST_PACKAGE_DIR names. */
export async function engine(host: SessionHost): Promise<ConversationEngine> {
	const packageDir = process.env.PI_HOST_PACKAGE_DIR;
	if (!packageDir)
		throw new Error("PI_HOST_PACKAGE_DIR names no pi built for the host");
	const compat = piModule<Compat>(
		await import(
			pathToFileURL(
				join(packageDir, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
			).href
		),
	);
	const core = scriptedCore(await fauxOf(packageDir));
	compat.registerApiProvider({
		api: core.api,
		stream: core.stream,
		streamSimple: core.streamSimple,
	});
	writeAgentFolder();
	return createEngine({
		packageDir,
		stateDir: join(homedir(), ".local", "state", "host-engine"),
		host,
		// What the host program gives every conversation, less what only
		// the host may see.
		env: conversationBase(process.env),
		key: {
			inherited: false,
			current: async () => "sealed-key",
			refused: () => {},
		},
	});
}

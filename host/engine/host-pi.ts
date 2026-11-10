/** The host's own pi, loaded from its install and refused unless it carries every seam the host needs. */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The pi libraries the engine drives, as their modules export them. They are
 * loaded from the host's pi install at start, never from this package's
 * dependencies: the host runs the patched pi its derivation built, and this
 * package keeps pi as an optional peer it never pins.
 */
export interface HostPiModules {
	/** `@earendil-works/pi-coding-agent`'s main entry. */
	readonly codingAgent: Readonly<Record<string, unknown>>;
	/**
	 * The coding agent's list of built-in extensions (tool_search, codemode,
	 * MCP and the rest), which its CLI loads and its main entry doesn't export.
	 */
	readonly builtins: Readonly<Record<string, unknown>>;
	/** `@earendil-works/pi-agent-core`'s main entry: the agent loop's defaults. */
	readonly agentCore: Readonly<Record<string, unknown>>;
	/** `@earendil-works/pi-ai`'s main entry: tool validation and transcript helpers. */
	readonly ai: Readonly<Record<string, unknown>>;
	/** `@earendil-works/pi-durable`'s main entry. */
	readonly durable: Readonly<Record<string, unknown>>;
	/** `@earendil-works/pi-durable/storage/sqlite/node`. */
	readonly sqlite: Readonly<Record<string, unknown>>;
	/** `@earendil-works/pi-durable/env/node`. */
	readonly nodeEnv: Readonly<Record<string, unknown>>;
	/** `@earendil-works/chord`'s context entry, which holds the background context. */
	readonly context: Readonly<Record<string, unknown>>;
}

/** One patch the host build applies, and how a loaded pi shows it is there. */
export interface HostSeam {
	/** The patch's file in core.nix's modules/pi, named in a refusal. */
	readonly patch: string;
	/** What the host loses without it, said in a refusal. */
	readonly why: string;
	readonly present: (modules: HostPiModules) => boolean;
}

/** The seams the engine refuses to open a conversation without. */
export const HOST_SEAMS: readonly HostSeam[] = [
	{
		patch: "pi-host-agent-interface.patch",
		why: "the session cannot drive the host's agent or build it from pi's own options",
		present: ({ codingAgent }) =>
			staticNumber(codingAgent.AgentSession, "hostAgentInterfaceVersion") === 1,
	},
	{
		patch: "pi-host-committed-turn.patch",
		why: "a committed turn cannot wait for pi to end or continue it",
		present: ({ durable }) => committedTurnGeneration(durable.GenerationTask),
	},
	{
		patch: "pi-host-interactive-lifecycle.patch",
		why: "a conversation's screen would own the host's process exit and signals",
		present: ({ codingAgent }) =>
			staticNumber(codingAgent.InteractiveMode, "hostedLifecycleVersion") === 1,
	},
	{
		patch: "pi-host-model-auth-context.patch",
		why: "a conversation's credentials would be read from the host's own environment",
		// Version 1 kept keys to the context but read header variables from the host's own environment; version 2 keeps both.
		present: ({ codingAgent }) =>
			(staticNumber(codingAgent.ModelRuntime, "hostAuthContextVersion") ?? 0) >=
			AUTH_CONTEXT_VERSION,
	},
];

/** The auth-context patch's version the host accepts from. */
const AUTH_CONTEXT_VERSION = 2;

/** A pi install that lacks seams the host needs, with each one named. */
export class HostPiRefused extends Error {
	readonly missing: readonly HostSeam[];

	constructor(packageDir: string, missing: readonly HostSeam[]) {
		const lines = missing.map(
			(seam) => `${seam.patch}: without it ${seam.why}`,
		);
		super(
			`The pi at ${packageDir} is not the host's build; it lacks ${lines.join("; ")}`,
		);
		this.name = "HostPiRefused";
		this.missing = missing;
	}
}

/** The host's pi, loaded and checked. */
export interface HostPi {
	readonly packageDir: string;
	/** The version the install says it is, which each conversation's harness settings name. */
	readonly version: string;
	/** The install's pi command, the entry script its package names as bin pi, which a subagent runs. */
	readonly command: string;
	readonly modules: HostPiModules;
}

/** Where one library sits in an installed pi: beside the coding agent, under its node_modules. */
function libraryEntry(
	packageDir: string,
	library: string,
	entry: string,
): string {
	return join(
		packageDir,
		"node_modules",
		"@earendil-works",
		library,
		"dist",
		entry,
	);
}

/**
 * The module files of a pi install. Both World's install and nixpkgs' put
 * the coding agent's dist at the package root and its libraries in
 * node_modules beside it.
 */
export function hostPiFiles(
	packageDir: string,
): Record<keyof HostPiModules, string> {
	return {
		codingAgent: join(packageDir, "dist", "index.js"),
		builtins: join(packageDir, "dist", "extensions", "index.js"),
		agentCore: libraryEntry(packageDir, "pi-agent-core", "index.js"),
		ai: libraryEntry(packageDir, "pi-ai", "index.js"),
		durable: libraryEntry(packageDir, "pi-durable", "index.js"),
		sqlite: libraryEntry(
			packageDir,
			"pi-durable",
			join("storage", "sqlite", "node.js"),
		),
		nodeEnv: libraryEntry(packageDir, "pi-durable", join("env", "node.js")),
		context: libraryEntry(packageDir, "chord", join("context", "index.js")),
	};
}

/**
 * Load pi from the install at packageDir and check every seam, refusing with
 * each missing patch named, so a host on ordinary pi never opens a
 * conversation it would run wrongly.
 */
export async function loadHostPi(packageDir: string): Promise<HostPi> {
	if (!isAbsolute(packageDir)) {
		throw new Error(
			`The host's pi install must be an absolute path, not ${packageDir}`,
		);
	}
	const files = hostPiFiles(packageDir);
	const absent = Object.values(files).filter((file) => !existsSync(file));
	if (absent.length > 0) {
		throw new Error(
			`The pi at ${packageDir} is incomplete; it has no ${absent.join(", ")}`,
		);
	}
	const modules: HostPiModules = {
		codingAgent: await importModule(files.codingAgent),
		builtins: await importModule(files.builtins),
		agentCore: await importModule(files.agentCore),
		ai: await importModule(files.ai),
		durable: await importModule(files.durable),
		sqlite: await importModule(files.sqlite),
		nodeEnv: await importModule(files.nodeEnv),
		context: await importModule(files.context),
	};
	const missing = HOST_SEAMS.filter((seam) => !seam.present(modules));
	if (missing.length > 0) throw new HostPiRefused(packageDir, missing);
	const version = modules.codingAgent.VERSION;
	if (typeof version !== "string" || version === "")
		throw new Error(`The pi at ${packageDir} names no version`);
	return { packageDir, version, command: piCommand(packageDir), modules };
}

/** The entry script the install's package.json names as its pi command, refusing one it lacks. */
function piCommand(packageDir: string): string {
	const manifest = join(packageDir, "package.json");
	const parsed: unknown = existsSync(manifest)
		? JSON.parse(readFileSync(manifest, "utf8"))
		: undefined;
	const bin = isRecord(parsed) ? parsed.bin : undefined;
	const entry = isRecord(bin) ? bin.pi : undefined;
	const command =
		typeof entry === "string" ? resolve(packageDir, entry) : undefined;
	if (command === undefined || !existsSync(command))
		throw new Error(`The pi at ${packageDir} names no pi command`);
	return command;
}

async function importModule(
	file: string,
): Promise<Readonly<Record<string, unknown>>> {
	const loaded: unknown = await import(pathToFileURL(file).href);
	if (!isRecord(loaded))
		throw new Error(`${file} exports nothing the host can read`);
	return loaded;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return (
		(typeof value === "object" || typeof value === "function") && value !== null
	);
}

/** A class's static number, read without trusting its type. */
function staticNumber(owner: unknown, name: string): number | undefined {
	if (!isRecord(owner)) return undefined;
	const value = owner[name];
	return typeof value === "number" ? value : undefined;
}

/** Whether a GenerationTask holds the committed-turn phases at the version that introduced them. */
function committedTurnGeneration(task: unknown): boolean {
	if (!isRecord(task) || !isRecord(task.definition)) return false;
	const { version, phases } = task.definition;
	if (version !== COMMITTED_TURN_VERSION || !isRecord(phases)) return false;
	return COMMITTED_TURN_PHASES.every(
		(phase) => typeof phases[phase] === "function",
	);
}

/** GenerationTask's version from the committed-turn patch on. */
const COMMITTED_TURN_VERSION = 3;
const COMMITTED_TURN_PHASES = ["committedTurn", "turnBoundary"] as const;

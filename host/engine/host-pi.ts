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
	/**
	 * The coding agent's project-trust module, which decides whether a
	 * folder's own settings and extensions load, as its CLI does, and which
	 * its main entry doesn't export.
	 */
	readonly projectTrust: Readonly<Record<string, unknown>>;
	/** `@earendil-works/pi-agent-core`'s main entry: the agent loop's defaults. */
	readonly agentCore: Readonly<Record<string, unknown>>;
	/**
	 * `@earendil-works/pi-ai`'s main entry, or from a bundle the module it
	 * hands extensions, which holds all of it: tool validation and transcript
	 * helpers.
	 */
	readonly ai: Readonly<Record<string, unknown>>;
	/** `@earendil-works/pi-tui`'s main entry: the main-screen TUI a startup question is drawn in. */
	readonly tui: Readonly<Record<string, unknown>>;
	/** `@earendil-works/pi-durable`'s main entry. */
	readonly durable: Readonly<Record<string, unknown>>;
	/** `@earendil-works/pi-durable/storage/sqlite/node`. */
	readonly sqlite: Readonly<Record<string, unknown>>;
	/** `@earendil-works/pi-durable/env/node`. */
	readonly nodeEnv: Readonly<Record<string, unknown>>;
	/** `@earendil-works/chord`'s context entry, which holds the background context. */
	readonly context: Readonly<Record<string, unknown>>;
}

/** How the host loaded its pi: from the bundle's host entry, or file by file. */
export interface HostPiLoad {
	readonly bundled: boolean;
}

/** One patch the host build applies, and how a loaded pi shows it is there. */
export interface HostSeam {
	/** The patch's file in core.nix's modules/pi, named in a refusal. */
	readonly patch: string;
	/** What the host loses without it, said in a refusal. */
	readonly why: string;
	readonly present: (modules: HostPiModules, load: HostPiLoad) => boolean;
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
		patch: "pi-host-interactive-lifecycle.patch",
		why: "a quit typed while other windows watch would end the conversation without asking the one who typed it",
		// Added to the lifecycle patch as hosted.quit, after its version 1.
		present: ({ codingAgent }) =>
			hasFields(codingAgent.InteractiveMode) &&
			codingAgent.InteractiveMode.hostedQuit === true,
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

/**
 * The seams the host runs without, saying what goes missing: a host that
 * refused a runtime built before one would stop at its next start, so a
 * missing one is reported (HostPi.lacking) and the conversation opens.
 */
export const HOST_WANTED_SEAMS: readonly HostSeam[] = [
	{
		patch: "pi-host-agent-interface.patch",
		why: "words sent as a conversation reopens show nowhere until their turn starts",
		// Added to the agent-interface patch as hostQueueDisplay, after its version 1.
		present: ({ codingAgent }) =>
			hasFields(codingAgent.AgentSession) &&
			codingAgent.AgentSession.hostQueueDisplay === true,
	},
	{
		patch: "pi-host-runs-through-pi.patch",
		why: "a run the host carries on reaches the model without its extensions' sections",
		present: ({ codingAgent }) =>
			hasFields(codingAgent.AgentSession) &&
			codingAgent.AgentSession.hostRuns === true,
	},
	{
		patch: "pi-host-loads-one-bundle.patch",
		why: "each conversation loads pi file by file, with about 10 MB more heap and three times the CPU its bundle takes",
		present: (_modules, { bundled }) => bundled,
	},
];

/** What a pi lacking wanted seams goes without, each patch named once, for the host's report. */
export function lackingSeams(
	packageDir: string,
	lacking: readonly HostSeam[],
): string {
	return `The pi at ${packageDir} lacks ${seamReasons(lacking)}`;
}

/** Each patch named once, with what is lost without it. */
function seamReasons(seams: readonly HostSeam[]): string {
	const reasons = new Map<string, string[]>();
	for (const seam of seams)
		reasons.set(seam.patch, [...(reasons.get(seam.patch) ?? []), seam.why]);
	return [...reasons]
		.map(([patch, whys]) => `${patch}: without it ${whys.join(", and ")}`)
		.join("; ");
}

/** The auth-context patch's version the host accepts from. */
const AUTH_CONTEXT_VERSION = 2;

/** A pi install that lacks seams the host needs, with each one named. */
export class HostPiRefused extends Error {
	readonly missing: readonly HostSeam[];

	constructor(packageDir: string, missing: readonly HostSeam[]) {
		// A patch can add several seams; it is named once, with each reason.
		super(
			`The pi at ${packageDir} is not the host's build; it lacks ${seamReasons(missing)}`,
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
	/** The wanted seams this pi lacks, which the host reports and runs without. */
	readonly lacking: readonly HostSeam[];
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
		projectTrust: join(packageDir, "dist", "core", "project-trust.js"),
		agentCore: libraryEntry(packageDir, "pi-agent-core", "index.js"),
		ai: libraryEntry(packageDir, "pi-ai", "index.js"),
		tui: libraryEntry(packageDir, "pi-tui", "index.js"),
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
 * The bundle's host entry, which the one-bundle patch adds: what the host
 * loads beside the coding agent, built into the bundle's own chunks, so the
 * host and the extensions pi loads share one copy of every library.
 */
export function hostPiBundle(packageDir: string): string {
	return join(packageDir, "dist", "bundle", "host.js");
}

/** The scope every pi library is published under. */
export const PI_SCOPE = "@earendil-works/";

/**
 * The bundle's file for one library its virtual modules hand extensions,
 * re-exporting the bundle's own copy, which the one-bundle patch adds beside
 * the host entry: the host's code resolves its own pi imports to these, so
 * a library's state, such as pi-tui's kitty flag, is never split between
 * the host's copy and pi's.
 */
export function hostPiModule(packageDir: string, specifier: string): string {
	return join(
		packageDir,
		"dist",
		"bundle",
		"host-modules",
		`${specifier.slice(PI_SCOPE.length)}.js`,
	);
}

/** The host entry's version from the one-bundle patch on. */
const BUNDLE_HOST_ENTRY_VERSION = 1;

/** The libraries the host takes from the bundle's virtual modules, as extensions import them. */
const BUNDLED_LIBRARIES = {
	codingAgent: "@earendil-works/pi-coding-agent",
	agentCore: "@earendil-works/pi-agent-core",
	ai: "@earendil-works/pi-ai",
	tui: "@earendil-works/pi-tui",
} as const;

/**
 * Load pi from the install at packageDir and check every seam, refusing with
 * each missing patch named, so a host on ordinary pi never opens a
 * conversation it would run wrongly. A wanted seam it lacks is listed in
 * lacking instead, for the host to report. An install with the bundle's host
 * entry is loaded from it; one without is loaded file by file.
 */
export async function loadHostPi(packageDir: string): Promise<HostPi> {
	if (!isAbsolute(packageDir)) {
		throw new Error(
			`The host's pi install must be an absolute path, not ${packageDir}`,
		);
	}
	const bundle = hostPiBundle(packageDir);
	const bundled = existsSync(bundle);
	const modules = bundled
		? await bundledModules(packageDir, bundle)
		: await unbundledModules(packageDir);
	const missing = HOST_SEAMS.filter(
		(seam) => !seam.present(modules, { bundled }),
	);
	if (missing.length > 0) throw new HostPiRefused(packageDir, missing);
	const version = modules.codingAgent.VERSION;
	if (typeof version !== "string" || version === "")
		throw new Error(`The pi at ${packageDir} names no version`);
	const lacking = HOST_WANTED_SEAMS.filter(
		(seam) => !seam.present(modules, { bundled }),
	);
	return {
		packageDir,
		version,
		command: piCommand(packageDir),
		modules,
		lacking,
	};
}

/**
 * pi's modules from the bundle's host entry: the coding agent and its
 * libraries as its virtual modules hand them to extensions, and the rest as
 * the entry exports them, all from the bundle's chunks. Each pi library the
 * virtual modules hand out must have its host module, or the host's own
 * imports of it would load a second copy.
 */
async function bundledModules(
	packageDir: string,
	bundle: string,
): Promise<HostPiModules> {
	const entry = await importModule(bundle).catch((error: unknown) => {
		throw new Error(
			`pi's bundle host entry ${bundle} failed to load: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	});
	const version = entry.hostEntryVersion;
	if (
		typeof version !== "number" ||
		!Number.isInteger(version) ||
		version < BUNDLE_HOST_ENTRY_VERSION
	)
		throw new Error(
			`${bundle} names host entry version ${String(version)}; the host reads ${BUNDLE_HOST_ENTRY_VERSION} and on`,
		);
	const virtual = entry.VIRTUAL_MODULES;
	if (!hasFields(virtual))
		throw new Error(`${bundle} exports no VIRTUAL_MODULES`);
	const unshared = Object.keys(virtual).filter(
		(name) =>
			name.startsWith(PI_SCOPE) && !existsSync(hostPiModule(packageDir, name)),
	);
	if (unshared.length > 0)
		throw new Error(
			`${bundle} has no host module for ${unshared.join(", ")}, so the host's own imports would load a second copy`,
		);
	const library = (name: string) => {
		const found = virtual[name];
		if (!hasFields(found))
			throw new Error(`${bundle} hands extensions no ${name}`);
		return found;
	};
	const exported = (name: string) => {
		const found = entry[name];
		if (!hasFields(found)) throw new Error(`${bundle} exports no ${name}`);
		return found;
	};
	const { builtInExtensions, resolveProjectTrusted } = entry;
	if (!Array.isArray(builtInExtensions))
		throw new Error(`${bundle} exports no builtInExtensions`);
	if (typeof resolveProjectTrusted !== "function")
		throw new Error(`${bundle} exports no resolveProjectTrusted`);
	return {
		codingAgent: library(BUNDLED_LIBRARIES.codingAgent),
		agentCore: library(BUNDLED_LIBRARIES.agentCore),
		ai: library(BUNDLED_LIBRARIES.ai),
		tui: library(BUNDLED_LIBRARIES.tui),
		builtins: { builtInExtensions },
		projectTrust: { resolveProjectTrusted },
		durable: exported("durable"),
		sqlite: exported("durableSqlite"),
		nodeEnv: exported("durableNodeEnv"),
		context: exported("chordContext"),
	};
}

/** pi's modules file by file, from an install without the bundle's host entry. */
async function unbundledModules(packageDir: string): Promise<HostPiModules> {
	const files = hostPiFiles(packageDir);
	const absent = Object.values(files).filter((file) => !existsSync(file));
	if (absent.length > 0) {
		throw new Error(
			`The pi at ${packageDir} is incomplete; it has no ${absent.join(", ")}`,
		);
	}
	return {
		codingAgent: await importModule(files.codingAgent),
		builtins: await importModule(files.builtins),
		projectTrust: await importModule(files.projectTrust),
		agentCore: await importModule(files.agentCore),
		ai: await importModule(files.ai),
		tui: await importModule(files.tui),
		durable: await importModule(files.durable),
		sqlite: await importModule(files.sqlite),
		nodeEnv: await importModule(files.nodeEnv),
		context: await importModule(files.context),
	};
}

/** The entry script the install's package.json names as its pi command, refusing one it lacks. */
function piCommand(packageDir: string): string {
	const manifest = join(packageDir, "package.json");
	const parsed: unknown = existsSync(manifest)
		? JSON.parse(readFileSync(manifest, "utf8"))
		: undefined;
	const bin = hasFields(parsed) ? parsed.bin : undefined;
	const entry = hasFields(bin) ? bin.pi : undefined;
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
	if (!hasFields(loaded))
		throw new Error(`${file} exports nothing the host can read`);
	return loaded;
}

/**
 * Whether a value's fields can be read by name: any object, or a
 * function. The library's `isRecord` refuses both arrays and functions.
 * A function must pass, since what pi exports as a class, such as
 * `InteractiveMode`, carries the seams the host checks for. An array
 * passes too, and the fields the host asks for read as undefined on it.
 */
function hasFields(value: unknown): value is Readonly<Record<string, unknown>> {
	return (
		(typeof value === "object" || typeof value === "function") && value !== null
	);
}

/** A class's static number, read without trusting its type. */
function staticNumber(owner: unknown, name: string): number | undefined {
	if (!hasFields(owner)) return undefined;
	const value = owner[name];
	return typeof value === "number" ? value : undefined;
}

/** Whether a GenerationTask holds the committed-turn phases at the version that introduced them. */
function committedTurnGeneration(task: unknown): boolean {
	if (!hasFields(task) || !hasFields(task.definition)) return false;
	const { version, phases } = task.definition;
	if (version !== COMMITTED_TURN_VERSION || !hasFields(phases)) return false;
	return COMMITTED_TURN_PHASES.every(
		(phase) => typeof phases[phase] === "function",
	);
}

/** GenerationTask's version from the committed-turn patch on. */
const COMMITTED_TURN_VERSION = 3;
const COMMITTED_TURN_PHASES = ["committedTurn", "turnBoundary"] as const;

/**
 * Whether a conversation may load its folder's own settings and
 * extensions, decided as pi's CLI decides it as it builds a session: the
 * answer this host already gave the folder, then, where the folder holds
 * what needs trust, its extensions, pi's trust store and the default,
 * asking a person only where pi would and someone is there to answer.
 */
import type { HostPiModules } from "./host-pi.ts";

/** A question pi shows as it starts: a title and the labels to pick from, undefined when dismissed. */
export type StartupQuestion = (
	title: string,
	labels: readonly string[],
) => Promise<string | undefined>;

/** How one conversation's build may reach a person about its folder. */
export interface TrustAsking {
	/** Ask the person at its screen; none means nobody is there, so a folder pi would ask about stays untrusted. */
	readonly ask?: StartupQuestion;
	/** pi's own context for the question, as its screen hands one to a session it resumes. */
	readonly context?: object;
	/** Something said of the decision: an extension's error, or a folder left untrusted for want of a person. */
	warn(message: string): void;
}

/** What pi's services are built with to keep the decision. */
export interface TrustedServices {
	readonly settingsManager: object;
	readonly resourceLoaderReloadOptions?: {
		resolveProjectTrust(options: {
			extensionsResult: unknown;
		}): Promise<boolean>;
	};
}

/** The host's trust in each conversation's folder, kept for the host's life as pi's CLI keeps it for its own. */
export interface ProjectTrust {
	services(cwd: string, agentDir: string, asking: TrustAsking): TrustedServices;
}

/** The labels pi's confirm offers, as its startup screen shows them. */
const YES = "Yes";
const NO = "No";

interface TrustStore {
	get(cwd: string): boolean | null;
}

interface SettingsManager {
	getDefaultProjectTrust(): string;
}

interface SettingsManagerStatics {
	create(
		cwd: string,
		agentDir: string,
		options?: { projectTrusted?: boolean },
	): SettingsManager & object;
}

interface TrustModules {
	readonly ProjectTrustStore: new (agentDir: string) => TrustStore;
	readonly hasTrustRequiringProjectResources: (cwd: string) => boolean;
	readonly SettingsManager: SettingsManagerStatics;
	readonly resolveProjectTrusted: (options: {
		cwd: string;
		trustStore: TrustStore;
		defaultProjectTrust: string;
		extensionsResult: unknown;
		projectTrustContext: object;
		onExtensionError(message: string): void;
	}) => Promise<boolean>;
}

/**
 * Build the host's trust from pi's own pieces: the store and the check of
 * what needs trust from the coding agent's entry, and the decision itself
 * from its project-trust module, which the entry doesn't export.
 */
export function projectTrust(
	modules: Pick<HostPiModules, "codingAgent" | "projectTrust">,
): ProjectTrust {
	const pi = trustModules(modules);
	// pi's CLI keeps each folder's answer for its process; the host keeps it for its own life.
	const decided = new Map<string, boolean>();

	return {
		services(cwd, agentDir, asking) {
			const store = new pi.ProjectTrustStore(agentDir);
			const requiring = pi.hasTrustRequiringProjectResources(cwd);
			const known = decided.get(cwd);
			const resolving = known === undefined && requiring;
			const projectTrusted = resolving
				? false
				: (known ?? store.get(cwd) ?? !requiring);
			const settingsManager = pi.SettingsManager.create(cwd, agentDir, {
				projectTrusted,
			});
			if (!resolving) return { settingsManager };
			const defaultProjectTrust = pi.SettingsManager.create(
				cwd,
				agentDir,
			).getDefaultProjectTrust();
			return {
				settingsManager,
				resourceLoaderReloadOptions: {
					async resolveProjectTrust({ extensionsResult }) {
						const context = asking.context ?? questionContext(cwd, asking);
						const trusted = await pi.resolveProjectTrusted({
							cwd,
							trustStore: store,
							defaultProjectTrust,
							extensionsResult,
							projectTrustContext: context,
							onExtensionError: (message) => asking.warn(message),
						});
						decided.set(cwd, trusted);
						const unanswered =
							!trusted &&
							asking.context === undefined &&
							asking.ask === undefined &&
							defaultProjectTrust === "ask" &&
							store.get(cwd) === null;
						if (unanswered)
							asking.warn(
								`${cwd} is not trusted, so its own .pi settings and extensions are not loaded: pi asks before trusting a folder, and nobody is at this conversation to answer. Run /trust in pi there to decide for every session.`,
							);
						return trusted;
					},
				},
			};
		},
	};
}

/**
 * pi's context for the trust question, as its CLI builds one at start: a
 * screen where someone can answer, or none, in which pi's default of
 * asking leaves the folder untrusted.
 */
function questionContext(cwd: string, asking: TrustAsking): object {
	const { ask } = asking;
	return {
		cwd,
		mode: ask ? "tui" : "rpc",
		hasUI: ask !== undefined,
		ui: {
			select: (title: string, labels: readonly string[]) =>
				ask ? ask(title, labels) : Promise.resolve(undefined),
			confirm: async (title: string, message: string) =>
				ask ? (await ask(`${title}\n${message}`, [YES, NO])) === YES : false,
			// pi's startup screen takes typed answers; a hosted one offers only a pick.
			input: () => Promise.resolve(undefined),
			notify: (message: string, type?: string) => {
				if (type === "warning" || type === "error") asking.warn(message);
			},
		},
	};
}

function trustModules(
	modules: Pick<HostPiModules, "codingAgent" | "projectTrust">,
): TrustModules {
	const {
		ProjectTrustStore,
		hasTrustRequiringProjectResources,
		SettingsManager,
	} = modules.codingAgent;
	const { resolveProjectTrusted } = modules.projectTrust;
	const absent = Object.entries({
		ProjectTrustStore,
		hasTrustRequiringProjectResources,
		resolveProjectTrusted,
	})
		.filter(([, value]) => typeof value !== "function")
		.map(([name]) => name);
	if (!hasCreate(SettingsManager)) absent.push("SettingsManager.create");
	if (absent.length > 0)
		throw new Error(
			`The host's pi cannot decide a folder's trust as pi does; it lacks ${absent.join(", ")}`,
		);
	// Each is checked a function above and is pi's own export of that name, whose signature pi's types give.
	return {
		ProjectTrustStore,
		hasTrustRequiringProjectResources,
		SettingsManager,
		resolveProjectTrusted,
	} as TrustModules;
}

function hasCreate(value: unknown): boolean {
	return (
		typeof value === "function" &&
		"create" in value &&
		typeof value.create === "function"
	);
}

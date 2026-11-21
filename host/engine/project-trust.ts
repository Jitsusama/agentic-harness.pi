/**
 * Whether a conversation may load its folder's own settings and
 * extensions, decided as pi's CLI decides it as it builds a session: the
 * answer this host already gave the folder, then, where the folder holds
 * what needs trust, its extensions, pi's trust store and the default,
 * asking a person only where pi would and someone is there to answer.
 *
 * Code a trusted folder's .pi holds loads only as it was pinned
 * (project-code.ts): new or changed code asks the person at the
 * conversation's screen, and with nobody there the folder loads
 * untrusted. The check runs again before each load of the folder's
 * resources, a reload's included, so code written between loads waits
 * for a yes too, and a folder dropped for changed code is trusted again
 * once its code is pinned again. A folder that holds nothing pi asks
 * trust for, or that the person said not to trust, loads none of its
 * code whatever it holds, so its code isn't checked or asked about.
 */
import type { HostPiModules } from "./host-pi.ts";
import {
	type CodeStanding,
	codeStanding,
	pin,
	printable,
	projectCode,
	startPins,
	unpinnedSaying,
} from "./project-code.ts";

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
	isProjectTrusted(): boolean;
	setProjectTrusted(trusted: boolean): void;
	reload(): Promise<void>;
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
	// pi's CLI keeps each folder's answer for its process; the host keeps it for its own life, for the code the folder held when answered.
	const decided = new Map<string, boolean>();

	return {
		services(cwd, agentDir, asking) {
			const store = new pi.ProjectTrustStore(agentDir);
			const requiring = pi.hasTrustRequiringProjectResources(cwd);
			const untrusted = store.get(cwd) === false;
			startPins(agentDir);
			const standing: CodeStanding =
				requiring && !untrusted
					? codeStanding(cwd, agentDir)
					: { kind: "none" };
			const answered = decisionKey(cwd, standing);
			const known = decided.get(answered);
			const unpinned = standing.kind === "unpinned";
			// New code this build can't ask about, or too large to check, stays out, whatever the
			// folder's trust. Only a fresh open at a screen asks: a /new, fork or resume may have
			// someone there, so the warning doesn't say nobody is.
			const refused =
				unpinned && (asking.ask === undefined || !standing.code.complete);
			if (unpinned && known === false && !refused)
				asking.warn(
					`${unpinnedSaying(cwd, standing)}, and you said not to load it, so its own .pi settings and extensions are not loaded. Change it, or restart the host, to be asked again.`,
				);
			if (refused)
				asking.warn(
					standing.code.complete
						? `${unpinnedSaying(cwd, standing)}, so its own .pi settings and extensions are not loaded: only a conversation first opened there at a screen can allow it. Open one to be asked.`
						: `${unpinnedSaying(cwd, standing)}, so its own .pi settings and extensions are not loaded.`,
				);
			const resolving = !refused && known === undefined && requiring;
			// The person's no outranks a yes this host remembers, which may be for the folder before
			// it held code: the code check was skipped for it.
			const projectTrusted =
				!refused &&
				!untrusted &&
				(resolving ? false : (known ?? store.get(cwd) ?? !requiring));
			const settingsManager = pi.SettingsManager.create(cwd, agentDir, {
				projectTrusted,
			});
			guardLoads(settingsManager, cwd, agentDir, asking, {
				requiring: () => pi.hasTrustRequiringProjectResources(cwd),
				untrusted: () => store.get(cwd) === false,
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
						if (standing.kind === "unpinned") {
							const allowed = await allowCode(cwd, standing, asking);
							if (allowed !== true) {
								// A question closed unanswered is asked again at the next open.
								if (allowed === false) decided.set(answered, false);
								return false;
							}
							if (changedSince(cwd, standing, asking)) return false;
							const unwritten = pin(cwd, agentDir, standing.code);
							if (unwritten)
								asking.warn(
									`${printable(cwd)}'s code is allowed until the host restarts, since ${unwritten}; after that you are asked again.`,
								);
						}
						const context = asking.context ?? questionContext(cwd, asking);
						const trusted = await pi.resolveProjectTrusted({
							cwd,
							trustStore: store,
							defaultProjectTrust,
							extensionsResult,
							projectTrustContext: context,
							onExtensionError: (message) => asking.warn(message),
						});
						// pi's own question can wait as long as the person does, so the code shown must still be the code loaded.
						if (trusted && changedSince(cwd, standing, asking)) return false;
						decided.set(answered, trusted);
						const unanswered =
							!trusted &&
							asking.context === undefined &&
							asking.ask === undefined &&
							defaultProjectTrust === "ask" &&
							store.get(cwd) === null;
						if (unanswered)
							asking.warn(
								`${printable(cwd)} is not trusted, so its own .pi settings and extensions are not loaded: pi asks before trusting a folder, and nobody is at this conversation to answer. Run /trust in pi there to decide for every session.`,
							);
						return trusted;
					},
				},
			};
		},
	};
}

/**
 * Whether `cwd`'s code is no longer what `standing` found, said when it
 * isn't: a yes was for the code shown, so code that changed while a
 * question waited loads only after one of its own.
 */
function changedSince(
	cwd: string,
	standing: CodeStanding,
	asking: TrustAsking,
): boolean {
	// A folder that held no code when asked about has changed if it holds any now.
	const before = standing.kind === "none" ? undefined : standing.code.digest;
	if (projectCode(cwd)?.digest === before) return false;
	asking.warn(
		`${printable(cwd)}'s .pi code changed while you were asked, so this conversation leaves out its own .pi settings and extensions. Open another there to be asked about it as it is now.`,
	);
	return true;
}

/** What a folder's answer is kept under: the folder, and the code it held when answered. */
function decisionKey(cwd: string, standing: CodeStanding): string {
	return standing.kind === "none" ? cwd : `${cwd}\0${standing.code.digest}`;
}

/**
 * Ask the person whether `cwd`'s new or changed code may run outside the
 * sandbox: true for a yes, false for a no, nothing when nobody answered.
 */
async function allowCode(
	cwd: string,
	standing: CodeStanding & { kind: "unpinned" },
	asking: TrustAsking,
): Promise<boolean | undefined> {
	if (!asking.ask) return undefined;
	const answer = await asking.ask(
		`${unpinnedSaying(cwd, standing)}.\nLoad it, as you would any program you run?`,
		[YES, NO],
	);
	if (answer === YES) return true;
	return answer === NO ? false : undefined;
}

/**
 * Check the folder's code again before each load of its settings and
 * resources, which pi always begins by reloading the settings: a folder
 * whose code changed since it loaded drops to untrusted for this load,
 * said once for each change, rather than load the change unasked. Once
 * its code is pinned again, by a yes in another conversation or by
 * changing back, the next load trusts it again, since the drop was the
 * guard's and not the person's: but only while nobody else has set the
 * folder's trust since, and the person hasn't said not to trust it. A
 * conversation still trusted after the person said no is checked too,
 * since the no doesn't take its trust away.
 */
function guardLoads(
	settingsManager: SettingsManager,
	cwd: string,
	agentDir: string,
	asking: TrustAsking,
	folder: { requiring: () => boolean; untrusted: () => boolean },
): void {
	const reload = settingsManager.reload.bind(settingsManager);
	const setTrusted = settingsManager.setProjectTrusted.bind(settingsManager);
	let dropped = false;
	let said: string | undefined;
	// Trust set by anyone else, pi's /trust among them, is theirs: the guard gives back none it didn't take.
	settingsManager.setProjectTrusted = (...args) => {
		dropped = false;
		return setTrusted(...args);
	};
	settingsManager.reload = async () => {
		if (settingsManager.isProjectTrusted() || dropped) {
			const standing: CodeStanding = folder.requiring()
				? codeStanding(cwd, agentDir)
				: { kind: "none" };
			if (standing.kind === "unpinned") {
				setTrusted(false);
				dropped = true;
				if (said !== standing.code.digest)
					asking.warn(
						`${unpinnedSaying(cwd, standing)}, so loads leave out its own .pi settings and extensions until it is allowed. Open a conversation there at a screen to be asked; this one picks it up at its next reload.`,
					);
				said = standing.code.digest;
			} else if (dropped) {
				dropped = false;
				said = undefined;
				// A folder the person has since said not to trust stays untrusted.
				if (folder.requiring() && !folder.untrusted()) setTrusted(true);
			}
		}
		return reload();
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

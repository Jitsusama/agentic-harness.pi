/**
 * The layer consumers actually talk to.
 *
 * Everything below this is deliberately separate: a model, a
 * provider contract, a resolver, a draft. That separation is
 * what makes each piece testable, but a consumer should not
 * have to assemble them. So the engine does it: hand it a
 * reference or a checkout, get back something that knows its
 * own provider, capabilities, diff and stack, and can open a
 * draft about itself.
 */

import type { Exec, ExecResult } from "../exec/index.ts";
import { EXIT_ABORTED, EXIT_TIMED_OUT, run } from "../exec/index.ts";
import { resolveRepo, resolveTarget } from "./bind.ts";
import type { Capabilities } from "./capabilities.ts";
import type { Change, ChangeRef, RepoLocator, ReviewTarget } from "./change.ts";
import type { ChecksRollup } from "./checks.ts";
import type { ReviewConfig } from "./config.ts";
import type { DiffModel } from "./diff.ts";
import { parseUnifiedDiff } from "./diff.ts";
import type { DraftDeps, ReviewDraft } from "./draft/handle.ts";
import { openDraft } from "./draft/handle.ts";
import type { DraftStore } from "./draft/store.ts";
import type {
	ConversationFacet,
	RepoProbe,
	ReviewProvider,
} from "./provider.ts";
import { getReviewProvider } from "./register.ts";
import type { ResolvedVia } from "./resolve.ts";
import { resolveReference } from "./resolve.ts";
import type { Stack } from "./stack.ts";
import { upstreamBase } from "./upstream-base.ts";

/** What the engine needs to work. */
export interface ReviewEngineDeps {
	exec: Exec;
	store: DraftStore;
	/** The user's `review` config section, when there is one. */
	config?: ReviewConfig;
}

/** Which local refs to review. */
export type LocalSpec = { base: string; head: string } | { refs: string[] };

/** A target with its provider and everything reachable from it. */
export interface BoundTarget {
	target: ReviewTarget;
	provider: ReviewProvider;
	repo: RepoLocator;
	/**
	 * How this provider came to own the target.
	 *
	 * Carried because a failure reads completely differently depending on
	 * the answer. A reference resolved by claim landed on a provider that
	 * recognized its shape, and a shape like `owner/repo#n` belongs to no
	 * system in particular, so a not-found is as likely to mean the wrong
	 * system as a missing change. Resolved by config, the same not-found
	 * means what it says, and suggesting a pin would be noise about a pin
	 * that already decided.
	 */
	via: ResolvedVia;
	capabilities: Capabilities;
	/** The hosted change, when the target is one. */
	proposal(): Promise<Change | null>;
	/** Unified diff, from the provider or from local git. */
	diff(): Promise<string>;
	/** The same diff, parsed. */
	diffModel(): Promise<DiffModel>;
	/** The stack, when the provider can read one. */
	stack(): Promise<Stack | null>;
	/** CI state, when the provider reports it. */
	checks(): Promise<ChecksRollup | null>;
	/** The conversation, or null when nothing hosts this target. */
	conversation: ConversationFacet | null;
}

/** A checkout's provider, and what it can do here. */
export interface ServingRepo {
	provider: ReviewProvider;
	repo: RepoLocator;
	via: ResolvedVia;
	capabilities: Capabilities;
}

/** The substrate, assembled. */
export interface ReviewEngine {
	/** What a directory says about the repo it sits in. */
	probe(cwd: string): Promise<RepoProbe>;
	/** Resolve a reference, throwing the resolver's guidance. */
	resolve(input: string, cwd?: string): Promise<BoundTarget>;
	/**
	 * Bind a change whose system is already known.
	 *
	 * For a caller that resolved once and kept the answer. Going
	 * back through {@link resolve} would ask every provider to
	 * claim the name again, and claiming depends on the directory
	 * the question is asked from, so the same change can bind to a
	 * different system on a later call. That is exactly how a
	 * review reaches a mirror instead of the system of record.
	 */
	bound(change: ChangeRef): Promise<BoundTarget>;
	/** Review refs in a checkout, hosted or not. */
	fromLocal(repoRoot: string, spec: LocalSpec): Promise<BoundTarget>;
	/**
	 * Who serves this checkout, with nothing to review yet.
	 *
	 * For "what can be done here", which is asked before there is a change
	 * to ask it about. {@link fromLocal} needs refs, so answering through it
	 * meant inventing a base and a head nobody named.
	 */
	serving(cwd: string): Promise<ServingRepo>;
	openDraft(target: ReviewTarget): Promise<ReviewDraft>;
}

/** The two endpoints of whatever the target covers. */
function endpointsOf(target: ReviewTarget): { base: string; head: string } {
	if (target.kind === "range") {
		return { base: target.upstream?.commit ?? target.base, head: target.head };
	}
	if (target.kind === "stack") {
		// A stack's diff is everything from below its first ref to
		// the tip of its last.
		return {
			base: target.refs[0] ?? "HEAD",
			head: target.refs.at(-1) ?? "HEAD",
		};
	}
	throw new Error("a hosted change has no local endpoints");
}

/**
 * The provider a change names, or a refusal that names it back.
 *
 * A change carrying a system nobody registered almost always
 * means an extension did not load, and saying which system is
 * missing is what points at it.
 */
function providerFor(id: string): ReviewProvider {
	const provider = getReviewProvider(id);
	if (!provider) {
		throw new Error(
			`This change belongs to ${id}, and no ${id} provider is registered, so it cannot be reached. The extension that contributes it may not be loaded.`,
		);
	}
	return provider;
}

/**
 * What git exits with on any fatal error. Outside a repository is one,
 * told apart from the rest (dubious ownership, a missing directory, a
 * bad config) only by what git says.
 */
const GIT_FATAL = 128;

/** What git says on stderr when the directory is in no repository. */
const NOT_A_REPO_SAYS = "not a git repository";

/**
 * What git config answers, saying nothing, when no key matches. A spawn
 * that failed or a git killed by a signal comes back as exit 1 too, but
 * with something on stderr, so only a silent 1 means no remotes.
 */
const NO_MATCHING_KEY = 1;

/** What the fence answers when it refuses a git command. */
const GIT_REFUSED = 126;

/**
 * Failures asking again cannot help: the clock already gave the command
 * its ten minutes, the call was stopped, the fence refused, or git died
 * of something it will die of again.
 */
const NOT_RETRIED = new Set([
	EXIT_TIMED_OUT,
	EXIT_ABORTED,
	GIT_REFUSED,
	GIT_FATAL,
]);

/**
 * A probe, and what git failed to say while taking it.
 *
 * A remote read that failed used to answer "no remotes", and only the git
 * provider claims a checkout with none, so a hosted repo was keyed by its
 * path. Its rounds then sat where nothing asking by the hosted repo, such
 * as a merge gate, ever looks (core.nix#6040, 21 Nov).
 */
interface Probed {
	probe: RepoProbe;
	unread?: string;
}

/** A git read's answer, with the failure before it when it was asked twice. */
interface GitRead {
	result: ExecResult;
	first?: ExecResult;
}

/** The first line git said on failing, or its exit when it said nothing. */
function whatGitSaid(result: ExecResult): string {
	const said = result.stderr.trim().split("\n")[0];
	return said ? `${said} (exit ${result.code})` : `it exited ${result.code}`;
}

/** What both attempts of a failed read said, the first one first. */
function whatGitSaidEach(read: GitRead): string {
	return read.first === undefined
		? whatGitSaid(read.result)
		: `${whatGitSaid(read.first)}, then asked again, ${whatGitSaid(read.result)}`;
}

/**
 * What to do about a failed read, in a person's words: ask again only
 * where that can help, and otherwise point at what git said.
 */
function adviceFor(result: ExecResult): string {
	if (result.code === EXIT_ABORTED) {
		return "The call was stopped before git answered.";
	}
	if (result.code === GIT_REFUSED || result.code === GIT_FATAL) {
		return "Asking again will fail the same way until what git said is fixed.";
	}
	return "Asking again usually gets through.";
}

/** Build the engine. */
export function createReviewEngine(deps: ReviewEngineDeps): ReviewEngine {
	const draftDeps: DraftDeps = { store: deps.store };

	/**
	 * Run a git read, asking once more when it fails quickly in a way none
	 * of its answers explain, as a command that could not start or was
	 * killed under load does. A failure asking again cannot help is given
	 * back as it came.
	 */
	async function gitRead(
		args: string[],
		answered: (result: ExecResult) => boolean,
	): Promise<GitRead> {
		const first = await deps.exec("git", args);
		if (answered(first) || NOT_RETRIED.has(first.code)) {
			return { result: first };
		}
		return { result: await deps.exec("git", args), first };
	}

	async function readProbe(cwd: string): Promise<Probed> {
		const outside = (result: ExecResult) =>
			result.code === GIT_FATAL && result.stderr.includes(NOT_A_REPO_SAYS);
		const topRead = await gitRead(
			["-C", cwd, "rev-parse", "--show-toplevel"],
			(result) => result.code === 0 || outside(result),
		);
		const top = topRead.result;
		// Not being in a repo is an ordinary answer, not a failure:
		// a reference can still be a URL.
		if (outside(top)) return { probe: {} };
		if (top.code !== 0) {
			return {
				probe: {},
				unread: `git could not say whether ${cwd} is a checkout: ${whatGitSaidEach(topRead)}. ${adviceFor(top)}`,
			};
		}
		const repoRoot = top.stdout.trim();

		const none = (result: ExecResult) =>
			result.code === NO_MATCHING_KEY &&
			result.stderr.trim() === "" &&
			result.stdout.trim() === "";
		const remotesRead = await gitRead(
			["-C", repoRoot, "config", "--get-regexp", "^remote\\..*\\.url$"],
			(result) => result.code === 0 || none(result),
		);
		const remotes = remotesRead.result;
		if (remotes.code !== 0 && !none(remotes)) {
			return {
				probe: { repoRoot, remoteUrls: [] },
				unread: `git could not read the remotes of ${repoRoot}: ${whatGitSaidEach(remotesRead)}. ${adviceFor(remotes)}`,
			};
		}
		const lines = remotes.stdout
			.split("\n")
			.map((line) => line.trim().split(/\s+/));
		const remoteUrls = lines
			.map((words) => words[1])
			.filter((url): url is string => Boolean(url));
		const origin = lines.find((words) => words[0] === "remote.origin.url")?.[1];
		return {
			probe: { repoRoot, remoteUrls, ...(origin ? { origin } : {}) },
		};
	}

	async function probe(cwd: string): Promise<RepoProbe> {
		return (await readProbe(cwd)).probe;
	}

	/**
	 * A probe of a checkout somebody named, refused when git could not say
	 * whose it is, since the plain path is no answer: a round or a
	 * capability read under it belongs to the wrong repo.
	 */
	async function probeNamed(cwd: string): Promise<RepoProbe> {
		const { probe: probed, unread } = await readProbe(cwd);
		if (unread !== undefined) throw unreadRefusal(unread);
		return probed;
	}

	/** The refusal for a checkout git could not say whose it is. */
	function unreadRefusal(unread: string): Error {
		return new Error(
			`Whose repo this is cannot be told, and anything recorded would sit under its path where nothing asking by the hosted repo finds it, so nothing was recorded. ${unread}`,
		);
	}

	/** Wrap a resolved target in everything reachable from it. */
	function bind(
		target: ReviewTarget,
		provider: ReviewProvider,
		repo: RepoLocator,
		via: ResolvedVia,
	): BoundTarget {
		let diffText: Promise<string> | undefined;

		async function readDiff(): Promise<string> {
			if (target.kind === "change") {
				if (!provider.changes) {
					throw new Error(`the ${provider.id} provider cannot read a diff`);
				}
				try {
					return await provider.changes.diff(target.change);
				} catch (error) {
					// A big change is the case a diff is most wanted for and the one
					// that failed hardest: a backend that caps its own diff route
					// answered with a raw upstream refusal and the read was over,
					// while the same provider offered `fetchAsRef` for exactly this
					// and nothing reached for it. Bringing the commits down and
					// diffing them locally has no such cap.
					return await diffFromRef(target.change, error);
				}
			}
			const root = repo.localPath ?? target.repo.localPath;
			if (!root) {
				throw new Error(`${repo.key} has no local checkout to diff`);
			}
			const { base, head } = endpointsOf(target);
			return run(
				deps.exec,
				"git",
				["-C", root, "diff", `${base}...${head}`],
				`diffing ${base}...${head}`,
			);
		}

		/**
		 * The diff read from a ref the provider fetched, when its own route
		 * would not answer.
		 *
		 * The original failure is carried into anything said here, because the
		 * fallback can fail for reasons of its own and being told only about
		 * the second one sends somebody after the wrong problem.
		 */
		async function diffFromRef(
			change: ChangeRef,
			cause: unknown,
		): Promise<string> {
			const why = cause instanceof Error ? cause.message : String(cause);
			const fetchAsRef = provider.changes?.fetchAsRef;
			const root = repo.localPath ?? change.repo.localPath;
			if (!fetchAsRef || !root) {
				throw new Error(
					`${why}\n\nThe ${provider.id} provider ${fetchAsRef ? `has no local checkout of ${repo.key} to read ${change.label} into` : "cannot fetch a change as a ref"}, so there is no way around that. Read the change a file at a time instead.`,
				);
			}

			const head = await fetchAsRef(change, root);
			// The base is not fetched with it, and the diff is against the base.
			// Asking the provider what the base is costs one read and beats
			// guessing at a default branch name.
			const base = (await provider.changes?.fetch(change))?.base;
			if (base === undefined) {
				throw new Error(
					`${why}\n\n${change.label} was fetched to ${head}, but the ${provider.id} provider did not say what it is based on, so there is nothing to diff it against.`,
				);
			}

			const read = await deps.exec("git", [
				"-C",
				root,
				"diff",
				`${base}...${head}`,
			]);
			if (read.code !== 0) {
				// Both causes, because the fallback fails for its own reasons and
				// hearing only the second sends somebody after the wrong problem.
				// The usual one is a checkout that has never seen the base.
				throw new Error(
					`${why}\n\nReading it from a fetched ref instead did not work either: diffing ${base}...${head} in ${root} said ${read.stderr.trim() || `exit ${read.code}`}. Fetch ${base} into that checkout and try again.`,
				);
			}
			return read.stdout;
		}

		function diff(): Promise<string> {
			// One read per bound target: a diff is asked for by the
			// council, the planner and the renderer in turn.
			diffText ??= readDiff();
			return diffText;
		}

		return {
			target,
			provider,
			repo,
			via,
			capabilities: provider.capabilities(repo),
			conversation:
				target.kind === "change" ? (provider.conversation ?? null) : null,

			async proposal() {
				if (target.kind !== "change" || !provider.changes) return null;
				return provider.changes.fetch(target.change);
			},

			diff,

			async diffModel() {
				return parseUnifiedDiff(await diff());
			},

			async stack() {
				if (!provider.stacking) return null;
				if (target.kind === "change") {
					return provider.stacking.stack(target.change);
				}
				const { head } = endpointsOf(target);
				return provider.stacking.stack({ repo, ref: head });
			},

			async checks() {
				if (target.kind !== "change" || !provider.changes?.checks) {
					return null;
				}
				return provider.changes.checks(target.change);
			},
		};
	}

	/** Resolve a target to its provider, throwing the guidance. */
	function bindTargetOrThrow(
		target: ReviewTarget,
		context: { probe?: RepoProbe },
	): BoundTarget {
		const resolved = resolveTarget(target, {
			...(deps.config ? { config: deps.config } : {}),
			...(context.probe ? { probe: context.probe } : {}),
		});
		if (!resolved.resolved) throw new Error(resolved.message);
		return bind(target, resolved.provider, resolved.repo, resolved.via);
	}

	return {
		probe,

		async resolve(input, cwd) {
			const read = cwd ? await readProbe(cwd) : undefined;
			const config = deps.config ? { config: deps.config } : {};
			// A reference that needs no checkout, such as a URL, still
			// resolves where git could not read one. A bare number or a
			// branch would be claimed by the checkout's path, so it is
			// refused rather than keyed there.
			if (read?.unread !== undefined) {
				const alone = resolveReference(input, config);
				if (!alone.resolved) throw unreadRefusal(read.unread);
			}
			const probed = read?.unread === undefined ? read?.probe : undefined;
			const resolution = resolveReference(input, {
				...config,
				...(probed ? { probe: probed } : {}),
			});
			if (!resolution.resolved) throw new Error(resolution.message);
			const target: ReviewTarget = {
				kind: "change",
				change: resolution.change,
			};
			return bind(
				target,
				resolution.provider,
				resolution.change.repo,
				resolution.via,
			);
		},

		async bound(change) {
			// A change kept from an earlier resolution names its own provider,
			// which is the whole reason this path exists rather than asking
			// again. Nothing was claimed here, so nothing about claiming is
			// true of it: it resolved the way a pin does, by being told.
			return bind(
				{ kind: "change", change },
				providerFor(change.provider),
				change.repo,
				"config-repo",
			);
		},

		async serving(cwd) {
			const probed = await probeNamed(cwd);
			const resolved = resolveRepo(probed, {
				...(deps.config ? { config: deps.config } : {}),
			});
			if (!resolved.resolved) throw new Error(resolved.message);
			return {
				provider: resolved.provider,
				repo: resolved.repo,
				via: resolved.via,
				capabilities: resolved.provider.capabilities(resolved.repo),
			};
		},

		async fromLocal(repoRoot, spec) {
			const probed = await probeNamed(repoRoot);
			const root = probed.repoRoot ?? repoRoot;
			const repo: RepoLocator = { key: `local:${root}`, localPath: root };
			const upstream =
				"refs" in spec
					? undefined
					: await upstreamBase(deps.exec, root, spec.base, spec.head);
			const target: ReviewTarget =
				"refs" in spec
					? { kind: "stack", repo, refs: spec.refs }
					: {
							kind: "range",
							repo,
							base: spec.base,
							head: spec.head,
							...(upstream ? { upstream } : {}),
						};
			return bindTargetOrThrow(target, { probe: probed });
		},

		openDraft: (target) => openDraft(target, draftDeps),
	};
}

/** Kept so the stub compiles against its imports. */
void [openDraft, parseUnifiedDiff, resolveReference, resolveTarget, run];

/**
 * Types for push-hooks.mjs, which node runs directly as every git hook
 * of a shell pushing World, and the queue places the wrappers of.
 */

/** The variable holding how many git settings came before ours. */
export const PRIOR_VARIABLE: string;

/** The hook names git runs from a local repository's hooks folder. */
export const HOOK_NAMES: readonly string[];

/** The environment without the `core.hooksPath` setting pushes.ts added. */
export function withoutOurs(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

/** The paths and blobs the commits `now` holds that none of `known` do change. */
export function changedIn(
	known: readonly string[],
	now: string,
	env: NodeJS.ProcessEnv,
): { paths: string[]; blobs: string[] } | undefined;

/** Whether any of `blobs` is an LFS pointer, or nothing when unreadable. */
export function holdsPointer(
	blobs: readonly string[],
	env: NodeJS.ProcessEnv,
): boolean | undefined;

/** Whether LFS filters any of `paths` at `commit`, or nothing when unreadable. */
export function filtersAny(
	paths: readonly string[],
	commit: string,
	env: NodeJS.ProcessEnv,
): boolean | undefined;

/** The runnable hooks in a folder, sorted by name. */
export function hooksIn(folder: string): string[];

/** Whether a hook hands the push to git-lfs. */
export function runsLfs(hook: string): boolean;

/** The repository's own pre-push, sparing its LFS hooks where the push allows. */
export function prePush(
	hooks: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
	input: Buffer,
): number;

/** Why a push can leave out the LFS hook's scan, or nothing. */
export function lfsScanSpared(
	lines: string,
	env: NodeJS.ProcessEnv,
	remote?: string,
): string | undefined;

/** Runs the hook named `name` as the repository would have. */
export function hook(
	name: string,
	args: readonly string[],
	given: NodeJS.ProcessEnv,
): number;

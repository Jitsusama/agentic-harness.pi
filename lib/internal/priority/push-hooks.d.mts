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

/** Why a push can leave out the LFS hook's scan, or nothing. */
export function lfsScanSpared(
	lines: string,
	env: NodeJS.ProcessEnv,
): string | undefined;

/** Runs the hook named `name` as the repository would have. */
export function hook(
	name: string,
	args: readonly string[],
	given: NodeJS.ProcessEnv,
): number;

/**
 * Types for the stripped-source cache, which is plain `.mjs` because it
 * runs before node loads any of this package's TypeScript.
 */

import type { LoadHookSync, RegisterHooksOptions } from "node:module";

/** The variable that turns the cache off when it reads `off`. */
export const OFF_VARIABLE: string;

/** What decides whether the cache serves a process. */
export interface ProcessFacts {
	/** The process's environment. */
	readonly env: Readonly<Record<string, string | undefined>>;
	/** node's version, as `process.version` gives it. */
	readonly version: string;
	/** How node treats TypeScript, as `process.features.typescript` says. */
	readonly typescript: string | false | undefined;
	/** Whether source maps are on, as `process.sourceMapsEnabled` says. */
	readonly sourceMaps: boolean;
	/** Whether node has `registerHooks` and `stripTypeScriptTypes`. */
	readonly hooks: boolean;
}

/** Why the cache stands aside in such a process, or undefined when it serves. */
export function whyNot(facts: ProcessFacts): string | undefined;

/** The folder of pi's state that every install's folder lies in. */
export function cacheRoot(
	env: Readonly<Record<string, string | undefined>>,
	home: string,
): string;

/**
 * The folder name for the install at `packageRoot` under node `version`,
 * its package.json naming `type`.
 */
export function installKey(
	packageRoot: string,
	version: string,
	type?: string,
): string;

/** What an entry holding `stripped` reads on disk. */
export function entryText(stripped: string): string;

/** What the load hook reads, strips and keeps with. */
export interface LoadParts {
	/** The folder its entries lie in. */
	readonly folder: string;
	/** The URL of the folder whose own modules it keeps, ending in a slash. */
	readonly within: string;
	/** Reads a file as text, throwing when it can't. */
	readonly read: (path: string) => string;
	/** Strips a module's source as node would at its URL. */
	readonly strip: (source: string, url: string) => string;
	/** Takes a new entry's file and text to write. */
	readonly keep: (file: string, text: string) => void;
	/** Whether its folder may be read from, as it may by default. */
	readonly trusted?: () => boolean;
	/** Told of each entry it reads back. */
	readonly touch?: (file: string) => void;
}

/** A load hook keeping in `folder` what node strips. */
export function strippedSourceLoad(parts: LoadParts): LoadHookSync;

/** What a writer of an install's entries writes for. */
export interface WriterParts {
	/** The folder its entries lie in. */
	readonly folder: string;
	/** The install it serves. */
	readonly served: string;
	/** The node version it serves under. */
	readonly version: string;
	/** Told once, when a write first fails. */
	readonly report?: (said: string) => void;
	/** Told once the folder is made and private. */
	readonly made?: () => void;
}

/** A writer of an install's entries. */
export function entryWriter(
	parts: WriterParts,
): (file: string, text: string) => void;

/** What a sweep sweeps, and the folder it keeps. */
export interface SweepParts {
	/** The folder every install's folder lies in. */
	readonly root: string;
	/** The name of this start's own folder. */
	readonly keep: string;
	/** The install this start serves. */
	readonly served: string;
	/** The node version this start runs on. */
	readonly version: string;
	/** The time to sweep as of, in milliseconds. */
	readonly now?: number;
}

/**
 * Remove the folders in `root` but `keep` whose install is gone, that
 * hold `served` under another node, or that name none an hour after
 * they were made; and the entries in `keep` no start read for 30 days.
 */
export function sweepGone(parts: SweepParts): Promise<void>;

/** Whether the cache serves, and where; why it stands aside; or why it failed. */
export type StrippedSource =
	| { readonly state: "on"; readonly folder: string }
	| { readonly state: "off" | "failed"; readonly reason: string };

/** What a start may be given in place of the process's own. */
export interface StartOptions {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly home?: string;
	readonly packageRoot?: string;
	readonly facts?: ProcessFacts;
	readonly register?: (hooks: RegisterHooksOptions) => unknown;
	readonly report?: (said: string) => void;
}

/** Keep what node strips of this package, where node 22 strips it. */
export function startStrippedSourceCache(
	options?: StartOptions,
): StrippedSource;

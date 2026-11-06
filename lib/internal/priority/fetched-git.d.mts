/**
 * Types for fetched-git.mjs, which node runs directly as git and the
 * queue reads a fetch with, so the two read a fetch of main alike.
 */

/** What a plain fetch of origin's main asks. */
export interface MainFetch {
	readonly at: string | undefined;
	readonly quiet: boolean;
	readonly writesHead: boolean;
}

/** What a git command line asks, when it is a plain fetch of main. */
export function mainFetchOf(args: readonly string[]): MainFetch | undefined;

/** A remote's URL as git shows it. */
export function shownUrl(url: string): string;

/** The FETCH_HEAD line git writes for a fetch of main from `url`. */
export function fetchHeadLine(commit: string, url: string): string;

/** The PATH without `folder`. */
export function pathPast(path: string, folder: string): string;

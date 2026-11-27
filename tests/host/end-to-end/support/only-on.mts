// A host case that only one platform can run, skipped elsewhere with a note naming that platform.
/**
 * Some host cases read what only one platform has, as Linux's /proc. On
 * another they can't run, which is no check left unmade, so `pnpm
 * test:host`'s reporter (every-case-ran.mts) lets such a skip by, rather
 * than failing the Mac's whole run for it. It knows one from its note,
 * which these helpers write and read, so every other skip still fails.
 */
import { it, type TestFunction } from "vitest";

/** What a platform's own case says as it skips elsewhere. */
export function onlyOnNote(platform: NodeJS.Platform, why: string): string {
	return `only on ${platform}: ${why}`;
}

/** The platform a skip's note says its case runs on alone, if it says one. */
export function onlyOnPlatform(note: string | undefined): string | undefined {
	return note?.match(/^only on ([a-z0-9]+): /)?.[1];
}

/**
 * `it`, on `platform`; on any other, a case of the same name that skips
 * saying it runs only on `platform`, and `why`.
 */
export function itOnlyOn(platform: NodeJS.Platform, why: string) {
	return (name: string, fn: TestFunction, timeout?: number): void => {
		if (process.platform === platform) it(name, fn, timeout);
		else it(name, ({ skip }) => skip(onlyOnNote(platform, why)), timeout);
	};
}

/**
 * Three shell habits the harness's standing rules forbid, which rules
 * in the prompt did not stop.
 *
 * QCXZEB's learning sensor read the session logs of 2026-W44's first
 * day: of 17 sessions active, 14 cut build or test output with tail or
 * head, 13 waited with sleep, and 5 ran git stash, each against a rule
 * every one of them was given. Saying it again changed nothing, so the
 * commands are caught as they run instead.
 *
 * Each detector reads the command as the guardians do, with heredoc
 * bodies and quoted data stripped, so a script or a message that only
 * mentions one of these is never caught.
 *
 * A fourth came later from the same sensor: a tracked file edited from
 * the shell, by a redirect, `tee`, `sed -i` or `perl -i`, seen in 45
 * sessions from 2026-10-19 to 2026-10-26, against a rule Joel captured
 * after a language server kept answering from a file the shell had
 * rewritten under it.
 */

import {
	type CommandPlace,
	resolveBashWrites,
} from "../core/internal/quest/bash-write.ts";
import { isTracked } from "./quest/git-signals.ts";

/**
 * The programs whose output is a build's or a test run's: what the
 * rule about tail and head is for, since pi keeps the end of what a
 * command prints and saves the rest, and a pipe holds it all back.
 */
const RUNNER =
	/(?:^|[\s;&|(])(?:vitest|jest|pytest|cargo\s+(?:test|build|clippy|nextest)|pnpm\s+(?:test|lint|typecheck|build|exec|run)|npm\s+(?:test|run)|yarn\s+(?:test|build)|nix\s+(?:build|flake\s+check)|nix-build|changed-checks|go\s+(?:test|build)|make|tsc|biome)\b/;

/** A trailing pipe into tail or head, with only a line count. */
const TRAILING_CUT =
	/\s*\|\s*(?:tail|head)(?:\s+(?:-n\s*)?-?\d+|\s+-n\s+\d+)?\s*$/;

/**
 * The command without a trailing `| tail -N` or `| head -N`, when what
 * it pipes is a build or a test run; nothing when there is none to drop.
 *
 * `stripped` is the command with its heredocs and quoted data taken
 * out, which is where the pipe has to be found: one inside a string is
 * the string's.
 */
export function withoutOutputCut(
	command: string,
	stripped: string,
): string | undefined {
	if (!TRAILING_CUT.test(stripped) || !TRAILING_CUT.test(command)) {
		return undefined;
	}
	const before = stripped.replace(TRAILING_CUT, "");
	if (!RUNNER.test(before)) return undefined;
	return command.replace(TRAILING_CUT, "");
}

/** `git stash` saving work, as opposed to reading or restoring a stash. */
const STASH_SAVE =
	/(?:^|[\s;&|(])git(?:\s+-C\s+\S+)?\s+stash(?!\s+(?:list|show|pop|apply|drop|clear|branch)\b)/;

/** Why a command that stashes work is refused, or nothing. */
export function stashRefusal(stripped: string): string | undefined {
	if (!STASH_SAVE.test(stripped)) return undefined;
	return "git stash keeps work where no other session and no quest can see it, in a list every worktree of the repo shares. Keep it on a branch instead: work's branch action, then record, or copy the file aside into $TMPDIR.";
}

/**
 * The files git tracks that a command rewrites from the shell: the
 * targets of its redirects, `tee`, `sed -i` and `perl -i`, placed in
 * the directory each part of the command runs in. A target whose place
 * the command does not say is left out rather than guessed, and so is
 * anything git does not track: a new file, scratch, `/dev/null`.
 */
export function trackedShellEdits(
	command: string,
	place: CommandPlace,
	tracked: (path: string) => boolean = isTracked,
): string[] {
	return resolveBashWrites(command, place).paths.filter(tracked);
}

/** Why a command that rewrites tracked files from the shell is refused. */
export function shellEditRefusal(files: readonly string[]): string {
	const named = files.map((file) => `\`${file}\``).join(", ");
	return `This rewrites ${named} from the shell, which git tracks. Use the edit tool for a change in place, or write for a whole file: a shell rewrite skips the edit path, and the language server goes on answering from what it last read.`;
}

/** A sleep and its length, with an optional unit. */
const SLEEP =
	/(?:^|[\s;&|(]|\b(?:do|then)\s)sleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/g;

/** How long a sleep may hold the session before it is a wait, in seconds. */
const LONGEST_SLEEP_S = 10;

const SECONDS: Record<string, number> = {
	"": 1,
	s: 1,
	m: 60,
	h: 3600,
	d: 86_400,
};

/**
 * Why a command that waits with a long sleep is refused, or nothing.
 * A short sleep between polls of something is how a wait should go,
 * so only one of ten seconds or more is refused.
 */
export function sleepRefusal(stripped: string): string | undefined {
	for (const match of stripped.matchAll(SLEEP)) {
		const seconds = Number(match[1]) * (SECONDS[match[2] ?? ""] ?? 1);
		if (seconds >= LONGEST_SLEEP_S) {
			return `A sleep of ${seconds} s holds this session and hears nothing meanwhile. Run what you are waiting on with background: true and carry on: its result arrives as a message of its own. To wait on something already running, check it in short calls.`;
		}
	}
	return undefined;
}

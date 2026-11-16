/**
 * Which running commands a host restart must not cut, whatever carrying
 * them would do: builds, checks and test suites, which lose their whole
 * run when cut and take minutes to an hour to run again. On 16 November
 * a hand restart of the background host ended six such runs, among them
 * a ten-check run of mycelium #240 and the clipboard VM test for core
 * #5002, since the skip before it looked for none (WCJQSG [a6d540f2]).
 *
 * Read from the command's label, its first line as the shell's job names
 * it, so a run that pipes or chains still matches its first word.
 */

/** What marks a command as a heavy run: a build, a check or a whole suite. */
const HEAVY: readonly RegExp[] = [
	/\bnix-offload\b/,
	/\bchanged-checks\b/,
	/\bhost-test-there\b/,
	/\bmerge-gate\b/,
	/\bhost-gate\b/,
	/\bpnpm (run )?(check|test)\b/,
	/\bvitest\b/,
	/\bnix (build|flake check)\b/,
	/\bnixos-rebuild\b/,
	/\bswitch-system\b/,
];

/** Whether a running command, by its label, is a heavy run a restart must not cut. */
export function isHeavy(label: string): boolean {
	return HEAVY.some((heavy) => heavy.test(label));
}

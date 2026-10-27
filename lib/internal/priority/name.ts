/**
 * A plain name for the work a job does, for a person reading the queue.
 *
 * A job's `what` is the whole shell command it was asked with, and that
 * is often a loop over `$c.$t` that names nothing until it runs, so the
 * launcher can't show it. The names live in the Nix installables the
 * command builds: `.#checks.x86_64-linux.vm-desktop-launcher-answers`
 * is the check `vm-desktop-launcher-answers`, and
 * `.#nixosConfigurations.penelope.config.system.build.toplevel` is the
 * machine `penelope`. Read from a running job's own processes, they
 * are the expanded ones; read from `what`, only those written out.
 */

/** An installable's attribute path, after the flake's `#`. */
const INSTALLABLE = /#([\w"+-]+(?:\.[\w"+-]+)*)/g;

/** Outputs keyed by system, whose name is the part after it. */
const PER_SYSTEM = new Set([
	"apps",
	"checks",
	"devShells",
	"legacyPackages",
	"packages",
]);

/** Outputs keyed by a machine or a person, whose name is that key. */
const PER_HOST = new Set([
	"darwinConfigurations",
	"homeConfigurations",
	"nixosConfigurations",
]);

/**
 * The name of what these command lines build, or nothing when none
 * names an installable. Several are said as the first and a count.
 * A path still holding a shell variable is left out, since `$c` is not
 * a name anybody chose.
 */
export function workNameIn(commands: readonly string[]): string | undefined {
	const names: string[] = [];
	for (const command of commands) {
		for (const match of command.matchAll(INSTALLABLE)) {
			const end = (match.index ?? 0) + match[0].length;
			const rest = /^\S*/.exec(command.slice(end))?.[0] ?? "";
			if (rest.includes("$")) continue;
			const name = nameOf(match[1].replaceAll('"', "").split("."));
			if (name !== undefined && !names.includes(name)) names.push(name);
		}
	}
	if (names.length === 0) return undefined;
	const more = names.length - 1;
	return more === 0 ? names[0] : `${names[0]} and ${more} more`;
}

/** An attribute path's plain name. */
function nameOf(path: readonly string[]): string | undefined {
	const [output, key, name] = path;
	if (output === undefined || output === "") return undefined;
	if (PER_SYSTEM.has(output)) return name ?? key;
	if (PER_HOST.has(output)) return key;
	return path.join(".");
}

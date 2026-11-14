/**
 * What in the home folder runs code as the person later, which the
 * agent fence (`fence.ts`) keeps read-only inside: the settings and
 * startup files, programs' entries whose settings name a command, the
 * caches within them it binds back writable, and the programs it gives
 * a home of their own. Kept apart from the fence's mounts, since this
 * list grows with each program found reading such a file, and the
 * mounts change only with how bubblewrap is driven.
 */

import { join } from "node:path";

/**
 * The person's files that run code as them later, or say what does,
 * read-only inside: the shell's startup files, every program's settings
 * (systemd's units and quickshell's code among them), git's and npm's,
 * SSH's, what is on their path (their own bin, the Nix profile, dev's
 * toolchain), the launcher's entries, direnv's allow list, pi's own
 * settings and packages, and the skills and settings every agent loads.
 * Among programs' own entries, those read as the person later (ISXEG8,
 * 12 November): dbus's services, nvim's site plugins, the browser's
 * certificates, kubectl's and aws's settings, whose credential commands
 * run at their next call, gpg's agent settings, gradle's init scripts,
 * docker's plugins, and cargo's settings and the sources it extracted,
 * which it never checks again before building them; and rustup's
 * toolchains, whose binaries its proxies run, the browser's native
 * messaging hosts, each naming a program it runs, and bundler's
 * settings and plugins (ISXEG8, 12 November, again). And the
 * harness's own inboxes, which sessions trust for who wrote them: the
 * steer inboxes, where a file saying it is Joel's could pause, stop or
 * move another session, and the mesh's store, where a message could
 * claim any peer's address (KP0L6A, DJT4LK, 765QSB, 13 November). pi
 * itself, the launcher and the node write them from outside the fence.
 *
 * The home folder itself is read-only too, with every other hidden
 * entry in it bound back writable, since a dotfile is often a link into
 * the store: one a command could delete, and put a file of its own in
 * its place, if it could write the folder holding it. So a top entry
 * here can't be made by a command where it isn't. Each deeper one is a
 * folder, made before the fence where its top entry is there, so it
 * can always be bound read-only.
 */
export const READ_ONLY = [
	".config",
	".zshrc",
	".zshenv",
	".zprofile",
	".zlogin",
	".profile",
	".bashrc",
	".bash_profile",
	".gitconfig",
	".npmrc",
	".ssh",
	".agents",
	".claude",
	".claude-personal",
	".claude.json",
	".codex",
	".pki",
	".kube",
	".aws",
	".gnupg",
	".gradle",
	".docker",
	".cargo",
	".rustup",
	".mozilla",
	".bundle",
	".local/bin",
	".local/share/dbus-1",
	".local/share/nvim",
	".local/share/applications",
	".local/share/direnv/allow",
	".local/share/systemd",
	".local/share/pi-packages",
	".local/state/nix",
	".local/state/tec/toolchain",
	".local/state/pi/agentic-harness.pi/steer",
	".local/state/pi/agentic-harness.pi/mesh-workflow",
	".pi/agent",
] as const;

/**
 * The start of the names of the home folder's files that run code as
 * the person later and are named for the machine: zsh's completion
 * dump and its compiled copy, which every new shell's `compinit -C`
 * sources without checking.
 */
const READ_ONLY_NAMED = [".zcompdump"] as const;

/**
 * Programs' caches within a read-only entry, bound back writable: the
 * entry's settings run code, but a cache only saves a call. A folder
 * among them (a trailing `/`) is made before the fence, whose entry
 * holding it is read-only inside, when that entry is there.
 */
const CACHES_WITHIN = [
	".kube/cache/",
	".kube/http-cache/",
	".kube/gke_gcloud_auth_plugin_cache",
	".aws/sso/cache/",
	".aws/cli/cache/",
	".bundle/cache/",
] as const;

/**
 * The programs given a home of their own in the sandbox's cache rather
 * than theirs in the home folder, read-only inside, since they write
 * there as they work: cargo's registry and gradle's caches. The
 * person's cargo settings still apply, read as an ancestor's, and
 * cargo's home starts with copies of what the person's cargo fetched
 * (`fence-seed.ts`).
 */
export const OWN_HOMES = [
	["CARGO_HOME", "cargo"],
	["GRADLE_USER_HOME", "gradle"],
] as const;

/** Each of `CACHES_WITHIN` in the home folder `home`. */
export function cachesWithin(home: string): string[] {
	return CACHES_WITHIN.map((cache) => join(home, cache.replace(/\/$/, "")));
}

/**
 * The folders made before the fence, in the home folder `home`, where
 * their top entry is there: each deeper read-only path, and each folder
 * among the caches. Inside, nothing could make one, so a read-only path
 * not yet there could otherwise be made by a command, and aws fails
 * rather than skip a cache it can't write.
 */
export function foldersMadeFirst(home: string): string[] {
	return [
		...READ_ONLY.filter((path) => path.includes("/")),
		...CACHES_WITHIN.filter((cache) => cache.endsWith("/")),
	].map((path) => join(home, path.replace(/\/$/, "")));
}

/** Whether the home folder's entry `entry` is one `READ_ONLY` names, whole or by the start of its name. */
export function readOnlyEntry(entry: string): boolean {
	return (
		READ_ONLY.some((path) => path === entry) ||
		READ_ONLY_NAMED.some((start) => entry.startsWith(start))
	);
}

/** The read-only paths, for the home folder `home`. */
export function readOnlyPaths(home: string): string[] {
	return READ_ONLY.map((path) => join(home, path));
}

/**
 * The fence on macOS: bubblewrap's mounts read as a sandbox-exec
 * profile, rule for rule, with mach services allowed only by name.
 */

import { describe, expect, it } from "vitest";
import {
	MAC_HIDDEN,
	MAC_PROGRAMS,
	MAC_READ_ONLY,
	MACH_ALLOWED,
	seatbeltProfile,
} from "../../../../lib/internal/fence/fence-seatbelt.ts";

const same = (path: string) => path;

/** The profile's lines between its fixed opening and its fixed close. */
function profileRules(args: readonly string[]): string[] {
	const { profile } = seatbeltProfile(args, { sockets: [], real: same });
	const lines = profile.split("\n");
	const close = MAC_PROGRAMS.length + 1;
	return lines.slice(
		lines.indexOf(";; Mounts, in the order bubblewrap takes them, last wins.") +
			1,
		-close,
	);
}

/** The mounts' own rules, before the hides are laid again. */
function fileRules(args: readonly string[]): string[] {
	const rules = profileRules(args);
	const again = rules.indexOf(
		";; Every hide again, so no mount laid after it reopens one.",
	);
	return [
		...rules.slice(0, again),
		...rules
			.slice(again + 1)
			.filter((rule) => !rules.slice(0, again).includes(rule)),
	];
}

describe("the fence's mounts as a profile", () => {
	it("keeps a mount laid before its folder's hide hidden, as bubblewrap would", () => {
		const rules = profileRules([
			"--ro-bind",
			"/Users/j/.ssh/config",
			"/Users/j/.ssh/config",
			"--tmpfs",
			"/Users/j/.ssh",
		]);
		const ssh = rules.lastIndexOf(
			'(deny file-read* file-write* (subpath "/Users/j/.ssh"))',
		);
		const config = rules.lastIndexOf(
			'(allow file-read* (subpath "/Users/j/.ssh/config"))',
		);

		expect(config, "not let back after the hide").toBeLessThan(ssh);
	});

	it("leaves a writable folder inside a read-only one writable after the hides", () => {
		const rules = profileRules([
			"--ro-bind",
			"/Users/j",
			"/Users/j",
			"--tmpfs",
			"/Users/j/.ssh",
			"--bind",
			"/Users/j/work",
			"/Users/j/work",
		]);
		const work = rules.lastIndexOf(
			'(allow file-read* file-write* (subpath "/Users/j/work"))',
		);
		const home = rules.lastIndexOf('(deny file-write* (subpath "/Users/j"))');

		expect(work, "the folder's grant is last").toBeGreaterThan(home);
	});

	it("keeps a folder above a closed one from removal by its own name and its link's", () => {
		const linked = (path: string) =>
			path.replace("/Users/j/.local/state", "/Volumes/d/state");
		const { profile } = seatbeltProfile(
			["--tmpfs", "/Users/j/.local/state/pi"],
			{ sockets: [], real: linked, home: "/Users/j" },
		);
		const lines = profile.split("\n");

		for (const named of ["/Users/j/.local/state", "/Volumes/d/state"]) {
			expect(lines, named).toContain(
				`(deny file-write-unlink (literal "${named}"))`,
			);
		}
	});

	it("grants a tree in a hidden folder again after every hide", () => {
		const { profile } = seatbeltProfile(
			["--bind", "/Users/j/t", "/Users/j/t"],
			{
				sockets: [],
				real: same,
				home: "/Users/j",
				regranted: [
					{
						tree: "/Users/j/.local/state/pi/trees/t",
						writes: "/Users/j/.local/state/pi/trees/t",
					},
				],
			},
		);
		const lines = profile.split("\n");
		const state = lines.lastIndexOf(
			'(deny file-read* file-write* (subpath "/Users/j/.local/state/pi"))',
		);
		const tree = lines.lastIndexOf(
			'(allow file-write* (subpath "/Users/j/.local/state/pi/trees/t"))',
		);

		expect(state, "pi's state is hidden").toBeGreaterThan(-1);
		expect(tree, "the tree comes after").toBeGreaterThan(state);
	});

	it("lets a strict run stat its held tree's files after the hides' metadata denies", () => {
		const tree = "/Users/j/.local/state/pi/trees/t";
		const { profile } = seatbeltProfile(["--bind", tree, tree], {
			sockets: [],
			real: same,
			home: "/Users/j",
			homeReads: [tree],
			regranted: [{ tree, writes: tree }],
		});
		const lines = profile.split("\n");
		const denied = lines.lastIndexOf(
			'(deny file-read-metadata (subpath "/Users/j/.local/state/pi"))',
		);
		const statable = lines.lastIndexOf(
			`(allow file-read-metadata (subpath "${tree}"))`,
		);

		expect(denied, "pi's state has its metadata refused").toBeGreaterThan(-1);
		expect(statable, "the tree's metadata comes back after").toBeGreaterThan(
			denied,
		);
	});

	it("finds a way down to a held tree whose real path left the home", () => {
		const { profile } = seatbeltProfile([], {
			sockets: [],
			real: same,
			home: "/Users/j",
			regranted: [
				{ tree: "/Volumes/d/state/pi/t", writes: "/Volumes/d/state/pi/t" },
			],
		});
		const lines = profile.split("\n");

		for (const step of [
			"/Volumes",
			"/Volumes/d",
			"/Volumes/d/state",
			"/Volumes/d/state/pi",
		]) {
			expect(lines, step).toContain(
				`(allow file-read-metadata (literal "${step}"))`,
			);
		}
	});

	it("lays every hide again after the last grant, with what it lets back read-only", () => {
		const rules = profileRules([
			"--tmpfs",
			"/Users/j/.ssh",
			"--ro-bind",
			"/Users/j/.ssh/config",
			"/Users/j/.ssh/config",
			"--ro-bind",
			"/dev/null",
			"/Users/j/.npmrc",
			"--bind",
			"/Users/j",
			"/Users/j",
		]);
		const at = (rule: string) => rules.lastIndexOf(rule);
		const granted = at('(allow file-read* file-write* (subpath "/Users/j"))');
		const ssh = at('(deny file-read* file-write* (subpath "/Users/j/.ssh"))');
		const npmrc = at(
			'(deny file-read* file-write* (literal "/Users/j/.npmrc"))',
		);
		const config = at('(allow file-read* (subpath "/Users/j/.ssh/config"))');

		expect(ssh, "~/.ssh hidden after the grant").toBeGreaterThan(granted);
		expect(npmrc, "~/.npmrc hidden after the grant").toBeGreaterThan(granted);
		expect(config, "ssh's settings readable after").toBeGreaterThan(ssh);
	});

	it("keeps a read-only mount from writes and a writable one open, in their order", () => {
		expect(
			fileRules([
				"--die-with-parent",
				"--bind",
				"/",
				"/",
				"--ro-bind",
				"/Users/j",
				"/Users/j",
				"--bind",
				"/Users/j/.cache",
				"/Users/j/.cache",
			]),
		).toEqual([
			'(allow file-read* (subpath "/Users/j"))',
			'(deny file-write* (subpath "/Users/j"))',
			'(allow file-read* file-write* (subpath "/Users/j/.cache"))',
		]);
	});

	it("hides what bubblewrap empties, and lets back only what it binds back", () => {
		expect(
			fileRules([
				"--tmpfs",
				"/Users/j/.ssh",
				"--ro-bind",
				"/Users/j/.ssh/config",
				"/Users/j/.ssh/config",
				"--remount-ro",
				"/Users/j/.ssh",
				"--ro-bind",
				"/dev/null",
				"/Users/j/.netrc",
			]),
		).toEqual([
			'(deny file-read* file-write* (subpath "/Users/j/.ssh"))',
			'(allow file-read* (subpath "/Users/j/.ssh/config"))',
			'(deny file-write* (subpath "/Users/j/.ssh/config"))',
			'(deny file-write* (subpath "/Users/j/.ssh"))',
			'(deny file-read* file-write* (literal "/Users/j/.netrc"))',
		]);
	});

	it("keeps a folder bubblewrap overlays from writes, having no overlay", () => {
		expect(
			fileRules(["--overlay-src", "/tmp/jiti", "--tmp-overlay", "/tmp/jiti"]),
		).toEqual([
			'(allow file-read* (subpath "/tmp/jiti"))',
			'(deny file-write* (subpath "/tmp/jiti"))',
		]);
		expect(() =>
			seatbeltProfile(["--overlay-src", "/a", "--tmp-overlay", "/b"], {
				sockets: [],
				real: same,
			}),
		).toThrow(/--overlay-src/);
	});

	it("keeps the folders above a cache outside the home from being moved", () => {
		const { profile } = seatbeltProfile(
			["--tmpfs", "/var/folders/ab/xy/T/jiti"],
			{
				sockets: [],
				real: same,
				home: "/Users/j",
				heldFromRoot: ["/var/folders/ab/xy/T/jiti"],
			},
		);
		for (const folder of ["/var/folders/ab/xy/T", "/var/folders/ab/xy"]) {
			expect(
				profile,
				`${folder} should be kept from being renamed or removed`,
			).toContain(`(deny file-write-unlink (literal "${folder}"))`);
		}
	});

	it("keeps a held cache from writes in a strict run whose folder holds it", () => {
		const cache = "/var/folders/ab/xy/T/jiti";
		const { profile } = seatbeltProfile(
			[
				...["--overlay-src", cache, "--tmp-overlay", cache],
				...["--bind", "/var/folders/ab/xy/T", "/var/folders/ab/xy/T"],
			],
			{ sockets: [], real: same, heldFromRoot: [cache] },
		);
		const lines = profile.split("\n");
		expect(
			lines.lastIndexOf(`(deny file-write* (subpath "${cache}"))`),
			"the cache's rule should come after the folder's grant",
		).toBeGreaterThan(
			lines.lastIndexOf(
				'(allow file-read* file-write* (subpath "/var/folders/ab/xy/T"))',
			),
		);
	});

	it("hides a file a copy stands in for, and says where the copy is", () => {
		const seatbelt = seatbeltProfile(
			["--ro-bind", "/run/pi/npmrc", "/Users/j/.npmrc"],
			{ sockets: [], real: same },
		);

		expect(seatbelt.profile).toContain(
			'(deny file-read* file-write* (literal "/Users/j/.npmrc"))',
		);
		expect(seatbelt.stoodIn).toEqual([
			{ copy: "/run/pi/npmrc", over: "/Users/j/.npmrc" },
		]);
	});

	it("names each path as the kernel sees it, past its links", () => {
		const real = (path: string) => path.replace(/^\/tmp/, "/private/tmp");

		const { profile } = seatbeltProfile(["--bind", "/tmp/t", "/tmp/t"], {
			sockets: [],
			real,
		});

		expect(profile).toContain('(subpath "/private/tmp/t")');
		expect(profile).not.toContain('"/tmp/t"');
	});

	it("quotes a path so no name can end the string it sits in", () => {
		const { profile } = seatbeltProfile(
			["--bind", '/Users/j/a") (allow default', '/Users/j/a") (allow default'],
			{ sockets: [], real: same },
		);

		expect(profile).toContain('(subpath "/Users/j/a\\") (allow default")');
	});

	it("refuses strict's reads in a home it isn't told, rather than reading all of it", () => {
		expect(() =>
			seatbeltProfile([], {
				sockets: [],
				real: same,
				homeReads: ["/Users/j/work"],
			}),
		).toThrow(/need the home/);
	});

	it("refuses a mount it can't say, rather than leaving it open", () => {
		expect(() =>
			seatbeltProfile(["--chmod", "0777", "/b"], { sockets: [], real: same }),
		).toThrow(/--chmod/);
		expect(() =>
			seatbeltProfile(["--bind", "/a"], { sockets: [], real: same }),
		).toThrow(/--bind/);
	});

	it("says nothing of a quest's TMPDIR link, which a Mac's command finds where pi made it", () => {
		const { profile } = seatbeltProfile(["--symlink", "/a", "/b"], {
			sockets: [],
			real: same,
		});
		expect(profile).not.toContain('"/b"');
	});
});

describe("what a fenced command reaches beyond its files", () => {
	const { profile } = seatbeltProfile([], {
		sockets: ["/nix/var/nix/daemon-socket/socket"],
		ports: [8484],
		real: same,
	});

	it("reaches mach services only by name, never LaunchServices, Apple Events or launchd's", () => {
		expect(profile).toContain("(deny mach-lookup)");
		for (const name of MACH_ALLOWED) {
			expect(profile, `${name} is allowed`).toContain(`"${name}"`);
		}
		for (const way of [
			"com.apple.coreservices.launchservicesd",
			"com.apple.coreservices.appleevents",
			"com.apple.pasteboard.1",
			"com.apple.SecurityServer",
		]) {
			expect(MACH_ALLOWED, `${way} stays refused`).not.toContain(way);
		}
	});

	it("signals and reads only processes of its own sandbox", () => {
		expect(profile).toContain("(deny signal (target others))");
		expect(profile).toContain("(allow signal (target same-sandbox))");
		expect(profile).toContain("(deny process-info* (target others))");
	});

	it("reaches no unix socket or local port but those it is given", () => {
		const lines = profile.split("\n");
		const unix = lines.indexOf("(deny network-outbound (remote unix-socket))");
		const local = lines.indexOf(
			'(deny network-outbound (remote ip "localhost:*"))',
		);

		expect(unix, "unix sockets are refused").toBeGreaterThan(-1);
		expect(local, "local ports are refused").toBeGreaterThan(-1);
		expect(lines.slice(unix + 1)).toContain(
			'(allow network-outbound (remote unix-socket (path-literal "/nix/var/nix/daemon-socket/socket")))',
		);
		expect(lines.slice(unix + 1), "names resolve").toContain(
			'(allow network-outbound (remote unix-socket (path-literal "/var/run/mDNSResponder")))',
		);
		expect(lines.slice(local + 1)).toContain(
			'(allow network-outbound (remote ip "localhost:8484"))',
		);
	});

	it("keeps what runs later as the person from writes, after every mount, but the folder's own", () => {
		const { profile: kept } = seatbeltProfile(
			["--bind", "/Users/j", "/Users/j"],
			{
				sockets: [],
				real: same,
				home: "/Users/j",
				folder: "/Users/j/src/t",
				path: [
					"/Users/j/src/t/node_modules/.bin",
					"/Users/j/.cargo/bin",
					"bin",
				],
			},
		);
		const lines = kept.split("\n");
		const mounted = lines.indexOf(
			'(allow file-read* file-write* (subpath "/Users/j"))',
		);
		const written = [
			...MAC_READ_ONLY.map((entry) => `/Users/j/${entry}`),
			...MAC_PROGRAMS,
			"/Users/j/.cargo/bin",
		];

		for (const where of written) {
			const rule = `(deny file-write* (subpath "${where}"))`;
			expect(
				lines.indexOf(rule),
				`${where} is kept after the mounts`,
			).toBeGreaterThan(mounted);
		}
		expect(kept, "the folder's own programs stay writable").not.toContain(
			"node_modules/.bin",
		);
		expect(kept, "a relative PATH entry names nothing").not.toContain('"bin"');
		expect(lines.at(-1), "no preference is written through cfprefsd").toBe(
			"(deny user-preference-write)",
		);
	});

	it("hides the Mac's own secrets, after every mount", () => {
		const { profile: homed } = seatbeltProfile(
			["--bind", "/Users/j", "/Users/j"],
			{ sockets: [], real: same, home: "/Users/j" },
		);
		const lines = homed.split("\n");
		const mounted = lines.indexOf(
			'(allow file-read* file-write* (subpath "/Users/j"))',
		);

		for (const hidden of MAC_HIDDEN) {
			const rule = `(deny file-read* file-write* (subpath "/Users/j/${hidden}"))`;
			expect(
				lines.indexOf(rule),
				`${hidden} is hidden after the mounts`,
			).toBeGreaterThan(mounted);
		}
	});
});

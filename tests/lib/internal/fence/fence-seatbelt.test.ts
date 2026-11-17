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

/** The profile's lines between its fixed opening and its fixed close, the mounts' own. */
function fileRules(args: readonly string[]): string[] {
	const { profile } = seatbeltProfile(args, { sockets: [], real: same });
	const lines = profile.split("\n");
	const close = MAC_PROGRAMS.length + 1;
	return lines.slice(
		lines.indexOf(";; Mounts, in the order bubblewrap takes them, last wins.") +
			1,
		-close,
	);
}

describe("the fence's mounts as a profile", () => {
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

	it("refuses a mount it can't say, rather than leaving it open", () => {
		expect(() =>
			seatbeltProfile(["--symlink", "/a", "/b"], { sockets: [], real: same }),
		).toThrow(/--symlink/);
		expect(() =>
			seatbeltProfile(["--bind", "/a"], { sockets: [], real: same }),
		).toThrow(/--bind/);
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

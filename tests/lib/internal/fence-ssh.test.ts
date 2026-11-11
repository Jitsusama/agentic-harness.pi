/**
 * The copy of the system's SSH settings the fence binds over them: each
 * included file written in where it was included, as ssh would read it,
 * and the copy made only when there is something to write in.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	fenceSshConfig,
	inlinedSshConfig,
	type SshFiles,
} from "../../../lib/internal/fence-ssh.ts";

/** Files holding `texts`, by path; a folder's names are those under it. */
function filesOf(texts: Record<string, string>): SshFiles {
	return {
		read: (path) => texts[path],
		entries: (folder) =>
			Object.keys(texts)
				.filter((path) => path.slice(0, path.lastIndexOf("/")) === folder)
				.map((path) => path.slice(folder.length + 1)),
	};
}

const SYSTEM = [
	"Host *",
	"  ForwardX11 no",
	"Include /nix/store/0000-libvirt/etc/ssh/ssh_config.d/30-libvirt.conf",
	"include=/nix/store/0000-systemd/lib/systemd/ssh_config.d/20-systemd.conf",
	"Host github.com",
	"  User git",
].join("\n");

const FILES = {
	"/etc/ssh/ssh_config": SYSTEM,
	"/nix/store/0000-libvirt/etc/ssh/ssh_config.d/30-libvirt.conf":
		"Host qemu/*\n  ProxyCommand virt-ssh-helper %h",
	"/nix/store/0000-systemd/lib/systemd/ssh_config.d/20-systemd.conf":
		"Host unix/*\n  ProxyCommand systemd-ssh-proxy %h %p",
};

describe("the system's SSH settings, with what they include written in", () => {
	it("puts each included file where it was included, and keeps every other line", () => {
		const copy = inlinedSshConfig(SYSTEM, filesOf(FILES)) ?? "";
		const lines = copy.split("\n");
		const at = (text: string) => lines.indexOf(text);
		expect(copy, "no Include is left for ssh to check").not.toMatch(
			/^include/im,
		);
		expect(at("  ProxyCommand virt-ssh-helper %h")).toBeGreaterThan(
			at("  ForwardX11 no"),
		);
		expect(at("  ProxyCommand systemd-ssh-proxy %h %p")).toBeGreaterThan(
			at("  ProxyCommand virt-ssh-helper %h"),
		);
		expect(at("Host github.com"), "what follows stays after").toBeGreaterThan(
			at("  ProxyCommand systemd-ssh-proxy %h %p"),
		);
	});

	it("takes a pattern's files in order, relative ones from /etc/ssh, and their own includes too", () => {
		const files = filesOf({
			"/etc/ssh/ssh_config.d/20-b.conf": "Include /etc/ssh/deeper.conf",
			"/etc/ssh/ssh_config.d/10-a.conf": "# a",
			"/etc/ssh/ssh_config.d/README": "not a setting",
			"/etc/ssh/deeper.conf": "# deeper",
		});
		const copy = inlinedSshConfig("Include ssh_config.d/*.conf", files);
		expect(copy?.split("\n")).toEqual([
			"# Include ssh_config.d/*.conf, written in by the agent fence",
			"# a",
			"# Include /etc/ssh/deeper.conf, written in by the agent fence",
			"# deeper",
		]);
	});

	it("is nothing when the settings include no file", () => {
		expect(inlinedSshConfig("Host *\n  User someone", filesOf({}))).toBe(
			undefined,
		);
	});

	it("leaves an include it can't read as a path where it was", () => {
		const copy = inlinedSshConfig('Include "~/odd name"', filesOf({}));
		expect(copy).toBe('Include "~/odd name"');
	});
});

describe("the copy the fence binds", () => {
	const runtimeDir = mkdtempSync(join(tmpdir(), "fence-ssh-"));
	afterAll(() => rmSync(runtimeDir, { recursive: true, force: true }));

	it("is written in pi's folder in the runtime folder, for the person alone", () => {
		const real: SshFiles = {
			read: (path) => {
				if (path in FILES) return FILES[path as keyof typeof FILES];
				try {
					return readFileSync(path, "utf8");
				} catch {
					// Not written yet.
					return undefined;
				}
			},
			entries: () => [],
		};
		const path = fenceSshConfig(runtimeDir, real);
		expect(path).toBe(join(runtimeDir, "pi-fence", "ssh_config"));
		expect(readFileSync(path ?? "", "utf8")).toBe(
			inlinedSshConfig(SYSTEM, filesOf(FILES)),
		);
		expect(statSync(path ?? "").mode & 0o777, "only the person reads it").toBe(
			0o600,
		);
		expect(fenceSshConfig(runtimeDir, real), "made once, then kept").toBe(path);
	});

	it("is nothing with no runtime folder, or settings that include nothing", () => {
		expect(fenceSshConfig(undefined, filesOf(FILES))).toBe(undefined);
		expect(
			fenceSshConfig(
				runtimeDir,
				filesOf({ "/etc/ssh/ssh_config": "Host *\n  User someone" }),
			),
		).toBe(undefined);
	});

	it("is nothing, and throws nothing, where it can't be written", () => {
		expect(fenceSshConfig("/proc/no-such-runtime", filesOf(FILES))).toBe(
			undefined,
		);
	});
});

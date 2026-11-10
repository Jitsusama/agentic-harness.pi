/**
 * The host pins its own pi as every conversation's subagent install, so
 * the subagent library, which refuses a hosted dispatch without one,
 * launches the host's pi rather than the host's script.
 */
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	hostedSubagentInstall,
	pinSubagentInstall,
} from "../../../host/engine/subagent-install.ts";
import { installHost, withSession } from "../../../lib/core/session/index.ts";
import { getParentPiInstall } from "../../../lib/subagent/install.ts";
import { sessionHost } from "../../support/session-host.ts";

const STARTUP_INSTALL_KEY = Symbol.for("pi.subagent.startupPiInstall");
const directories: string[] = [];

afterEach(() => {
	Reflect.deleteProperty(globalThis, STARTUP_INSTALL_KEY);
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

/** A pi install reached through a link, as the host's runtime link is. */
function linkedInstall(): { link: string; store: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-install-")));
	directories.push(root);
	const store = join(root, "store", "pi");
	const command = join(store, "dist", "bundle", "cli.js");
	mkdirSync(dirname(command), { recursive: true });
	writeFileSync(command, "");
	const link = join(root, "runtime");
	symlinkSync(store, link);
	return { link, store };
}

it("names the host's pi through its links, so a moved link cannot change it", () => {
	const { link, store } = linkedInstall();
	const install = hostedSubagentInstall({
		packageDir: link,
		command: join(link, "dist", "bundle", "cli.js"),
	});
	expect(install).toEqual({
		node: realpathSync(process.execPath),
		entry: join(store, "dist", "bundle", "cli.js"),
		packageDir: store,
	});
});

it("is what every hosted conversation's subagents take as the parent's install", () => {
	const { store } = linkedInstall();
	const install = hostedSubagentInstall({
		packageDir: store,
		command: join(store, "dist", "bundle", "cli.js"),
	});
	const { host } = sessionHost({ pid: 123, startedAt: 1000 });
	const removeHost = installHost(host);
	try {
		pinSubagentInstall(install);
		expect(withSession("a", getParentPiInstall)).toEqual(install);
		expect(withSession("b", getParentPiInstall)).toEqual(install);
	} finally {
		removeHost();
	}
});

it("replaces a capture already taken, which in a host names the host's script", () => {
	const { store } = linkedInstall();
	Reflect.set(globalThis, STARTUP_INSTALL_KEY, {
		node: "/node",
		entry: "/host/scripts/pi-host.ts",
	});
	const install = hostedSubagentInstall({
		packageDir: store,
		command: join(store, "dist", "bundle", "cli.js"),
	});
	pinSubagentInstall(install);
	expect(getParentPiInstall()).toEqual(install);
});

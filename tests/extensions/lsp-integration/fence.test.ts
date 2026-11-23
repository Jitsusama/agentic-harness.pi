/** A session's language servers run in the sandbox its commands run in. */
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	forServers,
	lspFence,
} from "../../../extensions/lsp-integration/fence.ts";
import { WATCHER } from "../../../lib/internal/fence/fence-child.ts";
import { OFF } from "../../../lib/internal/fence/fence-stage.ts";
import {
	SANDBOX_VARIABLE,
	wrapFor,
} from "../../../lib/internal/sandbox/sandbox.ts";
import { sandboxFolders } from "../../../lib/internal/sandbox/strict-rules.ts";
import { SSH_GUARD_OFF } from "../../../lib/internal/shell/ssh-guard.ts";

describe("the fence a session's language servers run in", () => {
	let home: string;
	let root: string;

	beforeEach(() => {
		home = realpathSync(mkdtempSync(join(tmpdir(), "lsp-fence-")));
		root = join(home, "project");
		mkdirSync(root);
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	const strict = { kind: "strict", landrun: "/fenced/landrun" } as const;
	const as =
		(
			session: string,
			cwd: string,
			env: NodeJS.ProcessEnv = {},
			guard = async () => SSH_GUARD_OFF,
		) =>
		() => ({ session, cwd, env, guard });

	it("is none where the session runs its commands as they are, without asking for the session", () => {
		const fence = lspFence({ kind: "none" }, () => {
			throw new Error("asked for the session");
		});

		expect(fence).toBeUndefined();
	});

	it("refuses every server, and pi's reads and writes for one, where the session's sandbox is refused, saying why", async () => {
		const fence = lspFence(
			{ kind: "refused", reason: "no landrun here" },
			as("one", root),
			home,
		);

		await expect(fence?.launch(["tsserver"])).resolves.toEqual({
			refused: "no landrun here",
		});
		expect(fence?.refuses("read", join(root, "a.ts"))).toBe("no landrun here");
	});

	it("launches the server's words as the session's sandbox wraps a command, from its environment, one fence a session", async () => {
		const env = { PATH: "/usr/bin", PI_SESSION_ID: "one" };
		const guard = vi.fn(async () => SSH_GUARD_OFF);

		const fence = lspFence(strict, as("one", root, env, guard), home);
		expect(
			guard,
			"the guard is read as a server starts",
		).not.toHaveBeenCalled();
		const launch = await fence?.launch(["/bin/tsserver", "--stdio"]);

		expect(fence?.key).toBe("strict|one");
		expect(launch).toEqual({
			text: expect.stringContaining("/fenced/landrun"),
			env,
		});
		expect(guard).toHaveBeenCalledOnce();
		expect(lspFence(strict, as("two", root), home)?.key).toBe("strict|two");
	});

	it("runs the watcher first, then catches the telling, so pi's end ends the server and the fence's check after it still runs", async () => {
		const launch = await lspFence(strict, as("one", root), home)?.launch([
			"tsserver",
		]);

		expect(launch && "text" in launch && launch.text).toMatch(
			new RegExp(
				`^${WATCHER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}trap : TERM HUP INT\n`,
			),
		);
	});

	it("refuses a server where the session's folder is one its sandbox won't let commands write", async () => {
		const launch = await lspFence(strict, as("one", home), home)?.launch([
			"tsserver",
		]);

		const text = launch && "text" in launch ? launch.text : "";
		expect(text).toContain(`let commands write ${home},`);
		expect(text).not.toContain("/fenced/landrun");
	});

	it("gives a server none of the person's accounts that a command is given", async () => {
		const github = vi.fn(() => "gh-token-mark");
		const gcloud = vi.fn(() => {
			throw new Error("a server asked for the cloud's grant");
		});

		const launch = await lspFence(
			{ ...strict, github, gcloud },
			as("one", root),
			home,
		)?.launch(["tsserver"]);

		const text = launch && "text" in launch ? launch.text : "";
		expect(text).toContain("tsserver");
		expect(text).not.toContain("gh-token-mark");
		expect(github).not.toHaveBeenCalled();
		expect(gcloud).not.toHaveBeenCalled();
	});

	it("gives a strict server no way to gcloud's settings, which the session's next command with the cloud's grant reads", async () => {
		const launch = await lspFence(strict, as("one", root), home)?.launch([
			"tsserver",
		]);

		const text = launch && "text" in launch ? launch.text : "";
		expect(text).toContain("tsserver");
		expect(text).not.toContain("pi-sandbox/gcloud");
		expect(text).not.toContain("CLOUDSDK_CONFIG");
	});

	it("draws the agent fence for a server without the GitHub door or nix-offload's way out, and with nothing that acts as the person", () => {
		const offload = { program: "/fenced/nix-offload" } as never;

		const served = forServers({
			kind: "fence",
			bwrap: "/fenced/bwrap",
			landrun: "/fenced/landrun",
			githubDoor: "/fenced/door",
			offload,
		});

		expect(served).toEqual({
			kind: "fence",
			bwrap: "/fenced/bwrap",
			landrun: "/fenced/landrun",
			served: true,
		});
	});

	it("wraps a server in the agent fence with no way to the person's agent or display, which a command's wrap has", () => {
		const runtimeDir = join(home, "run");
		mkdirSync(join(runtimeDir, "pi-fence-display"), { recursive: true });
		writeFileSync(join(runtimeDir, "pi-agent.sock"), "");
		writeFileSync(join(runtimeDir, "pi-fence-display/wayland"), "");
		const agentFence = {
			kind: "fence",
			bwrap: "/fenced/bwrap",
			landrun: "/fenced/landrun",
		} as const;
		const wrapped = (sandbox: Parameters<typeof wrapFor>[0]) =>
			wrapFor(
				sandbox,
				{ cwd: root, env: { XDG_RUNTIME_DIR: runtimeDir } },
				home,
			)?.("tsserver") ?? "";

		const command = wrapped(agentFence);
		const server = wrapped(forServers(agentFence));

		for (const way of ["SSH_AUTH_SOCK=", "WAYLAND_DISPLAY=", "pi-agent"]) {
			expect(command, `a command's wrap has ${way}`).toContain(way);
			expect(server, `a server's wrap has ${way}`).not.toContain(way);
		}
		expect(server).toContain("tsserver");
	});

	it("starts a server in the agent fence with none of the conversation's tokens, keys or sockets, keeping its session's id", async () => {
		const env = {
			PATH: "/usr/bin",
			PI_SESSION_ID: "one",
			GITHUB_TOKEN: "gh-token-mark",
			PI_PROXY_API_KEY: "proxy-key-mark",
			AWS_SECRET_ACCESS_KEY: "cloud-secret-mark",
			NPM_CONFIG_AUTH: "npm-auth-mark",
			SSH_AUTH_SOCK: "/run/agent.sock",
			npm_config__authToken: "npm-lower-mark",
			github_token: "gh-lower-mark",
		};

		const launch = await lspFence(
			{ kind: "fence", bwrap: "/fenced/bwrap", landrun: "/fenced/landrun" },
			as("one", root, env),
			home,
		)?.launch(["tsserver"]);

		expect(launch && "env" in launch && launch.env).toEqual({
			PATH: "/usr/bin",
			PI_SESSION_ID: "one",
		});
		const text = launch && "text" in launch ? launch.text : "";
		for (const mark of [
			"gh-token",
			"proxy-key",
			"cloud-secret",
			"npm-auth",
			"npm-lower",
			"gh-lower",
		])
			expect(text).not.toContain(mark);
	});

	it("refuses pi a write for a server where its sandbox refuses pi's own write tool, whatever the session's variable reads", () => {
		const fence = lspFence(
			strict,
			as("one", root, { [SANDBOX_VARIABLE]: OFF }),
			home,
		);

		expect(fence?.refuses("write", join(home, ".bashrc"))).toEqual(
			expect.any(String),
		);
		expect(fence?.refuses("write", join(root, "a.ts"))).toBeUndefined();
	});

	it("refuses pi a read or write for a strict server in gcloud's settings, which the server's own fence keeps it from", () => {
		const fence = lspFence(strict, as("one", root), home);
		const own = sandboxFolders(home);
		mkdirSync(own.gcloud, { recursive: true });
		mkdirSync(own.cache, { recursive: true });

		for (const use of ["write", "read"] as const)
			expect(
				fence?.refuses(use, join(own.gcloud, "credentials.db")),
				`a ${use} in gcloud's settings`,
			).toEqual(expect.any(String));
		expect(fence?.refuses("write", join(own.cache, "a"))).toBeUndefined();
	});
});

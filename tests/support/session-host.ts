/** Two-conversation hosts for tests of session-keyed state. */
import {
	type Host,
	installHost,
	releaseSession,
	type SessionEnvironment,
	type SessionOwner,
} from "../../lib/core/session/index.ts";

/**
 * Make a two-conversation host, leaving installation and disposal to
 * the test, under `key`, which a real host gives as `realm-kind`.
 * Closing a conversation releases only its slots.
 */
export function sessionHost(owner: SessionOwner, key = "test-host") {
	const open = new Set(["a", "b"]);
	const environments = new Map<string, SessionEnvironment>();
	const host: Host = {
		kind: "pi-durable",
		key,
		owner,
		holds: (id) => (open.has(id) ? "idle" : undefined),
		env(id) {
			let env = environments.get(id);
			if (!env) {
				const values: NodeJS.ProcessEnv = {};
				env = {
					get: (name) => values[name],
					set(name, value) {
						values[name] = value;
					},
					delete(name) {
						delete values[name];
					},
					snapshot: () => ({ ...values }),
				};
				environments.set(id, env);
			}
			return env;
		},
		hints: () => ({}),
		close(id) {
			open.delete(id);
			environments.delete(id);
			releaseSession(id);
		},
		stamp: () => {},
	};
	return { host, open };
}

/**
 * Install an in-process host under `key`; closing a conversation
 * releases only its slots.
 */
export function installTestHost(key?: string) {
	const { host } = sessionHost(
		{ pid: process.pid, startedAt: Date.now() },
		key,
	);
	const uninstall = installHost(host);
	return {
		host,
		dispose() {
			host.close("a", "test cleanup");
			host.close("b", "test cleanup");
			uninstall();
		},
	};
}

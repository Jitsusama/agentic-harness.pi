/**
 * process.env as the conversation that is running sees it.
 *
 * Code the harness does not own reads and writes process.env directly:
 * Shopify's proxy extension builds each request's context from it, and
 * its worktrail observer writes a run's variables into it for the
 * commands that run start. In a host that would hand one conversation's
 * attribution to another. So the host puts a view in process.env's
 * place: inside withSession, for a conversation the host holds, every
 * read, write, delete, key listing and descriptor is that
 * conversation's environment; anywhere else it is the host's own.
 *
 * Credentials are the exception. The engine resolves provider keys per
 * request, and a conversation's env never serves them here: the proxy
 * keys always read from the host's environment, which holds none, and a
 * write to one inside a conversation stays in that conversation's env
 * rather than reaching its neighbours, though its reads still come from
 * the host.
 *
 * What only the host's own process is (HOST_READS) is read but never
 * listed. Its unit names the ai-proxy-headers and worktrail it was built
 * with, and the program names the viewers' kitty terminal for pi-tui;
 * code in the host reads them, but a command a conversation starts never
 * gets them, since a newer pi it runs needs its own newer tools, found
 * on PATH, and its terminal is not a viewer's. A conversation that names
 * one for itself reads and hands on its own.
 *
 * Work a conversation left running after the host released it still
 * carries that conversation's ambient id. Its reads see the host's env,
 * but its writes and deletes are dropped, so a late write can't reach
 * the env every other conversation falls back on.
 */

import {
	ambientSession,
	type Host,
	type SessionEnvironment,
} from "../../lib/core/session/index.ts";

/** Keys the engine owns, which no conversation's env serves. */
const CREDENTIALS: ReadonlySet<string> = new Set([
	"SHOPIFY_PROXY_KEY",
	"PI_PROXY_API_KEY",
	"PI_PROXY_AUTH_HEADER",
]);

/**
 * What only the host's own process is, which code in the host reads
 * from the host's environment and no conversation's env holds or hands
 * on: the runtime's own tools, and the viewers' terminal as pi-tui is
 * told it.
 */
export const HOST_READS: readonly string[] = [
	"AI_PROXY_HEADERS_BIN",
	"WORKTRAIL_BIN",
	"PI_IMAGE_PROTOCOL",
	"PI_TRUE_COLOR",
	"PI_HYPERLINKS",
];

/** Install the view, returning what puts the host's own env back. */
export function installConversationEnv(host: Host): () => void {
	const own = process.env;
	// Spike (worker per engine): a worker's host answers holds for its
	// siblings' conversations too, but holds only its own env.
	const here = (id: string): boolean => {
		const local: unknown = Reflect.get(host, "holdsHere");
		return typeof local === "function"
			? Reflect.apply(local, host, [id]) === true
			: host.holds(id) !== undefined;
	};
	const current = (): SessionEnvironment | undefined => {
		const id = ambientSession();
		return id !== undefined && here(id) ? host.env(id) : undefined;
	};
	/** Running for a conversation the host has let go, whose writes go nowhere. */
	const released = (): boolean => {
		const id = ambientSession();
		return id !== undefined && !here(id);
	};
	const read = (name: string): string | undefined => {
		const env = current();
		if (!env || CREDENTIALS.has(name)) return own[name];
		const value = env.get(name);
		return value === undefined && HOST_READS.includes(name) ? own[name] : value;
	};
	const keys = (env: SessionEnvironment): string[] => [
		...(env.names?.() ?? Object.keys(env.snapshot())).filter(
			(name) => !CREDENTIALS.has(name),
		),
		...Object.keys(own).filter((name) => CREDENTIALS.has(name)),
	];
	const view = new Proxy(own, {
		get: (target, name) => {
			if (typeof name !== "string") return Reflect.get(target, name);
			return read(name);
		},
		has: (target, name) => {
			if (typeof name !== "string") return Reflect.has(target, name);
			return read(name) !== undefined;
		},
		set: (target, name, value) => {
			const env = current();
			if (typeof name === "string" && !env && released()) return true;
			if (typeof name !== "string" || !env)
				return Reflect.set(target, name, value);
			// process.env holds strings only, and says so by coercing.
			env.set(name, String(value));
			return true;
		},
		defineProperty: (target, name, descriptor) => {
			const env = current();
			if (typeof name === "string" && !env && released()) return true;
			if (typeof name !== "string" || !env)
				return Reflect.defineProperty(target, name, descriptor);
			env.set(name, String(descriptor.value));
			return true;
		},
		deleteProperty: (target, name) => {
			const env = current();
			if (typeof name === "string" && !env && released()) return true;
			if (typeof name !== "string" || !env)
				return Reflect.deleteProperty(target, name);
			env.delete(name);
			return true;
		},
		ownKeys: (target) => {
			const env = current();
			return env ? keys(env) : Reflect.ownKeys(target);
		},
		getOwnPropertyDescriptor: (target, name) => {
			const env = current();
			if (typeof name !== "string" || !env)
				return Reflect.getOwnPropertyDescriptor(target, name);
			// A host read the conversation never set is read, never listed.
			if (HOST_READS.includes(name) && env.get(name) === undefined)
				return undefined;
			const value = read(name);
			return value === undefined
				? undefined
				: { value, writable: true, enumerable: true, configurable: true };
		},
	});
	Object.defineProperty(process, "env", {
		value: view,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	// Only while it is still this view: a second host in one process (in
	// tests) wraps this one, so disposing the first before the second
	// leaves its view under the second's until that one goes too.
	return () => {
		if (process.env === view)
			Object.defineProperty(process, "env", {
				value: own,
				writable: true,
				enumerable: true,
				configurable: true,
			});
	};
}

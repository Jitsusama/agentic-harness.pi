/**
 * A real browser and a real server, shared by the suites that
 * need both.
 *
 * Every test under tests/browser drives Chrome, because the
 * faults in this layer are not about what the code computes but
 * about what the browser does with it. A unit test cannot fail on
 * an override the browser ignored, an event that arrived on the
 * wrong session, or a handle that went stale across a navigation.
 *
 * The pages are served from a server started here rather than
 * from disk or the internet, so the suite depends on nothing it
 * does not create and nothing that can change under it.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { resolveChromePath } from "../../lib/web/browser.js";

/**
 * Whether there is a browser to drive.
 *
 * Skipped rather than failed where there is none, so a checkout
 * on a machine without Chrome still runs the rest of the suite.
 * CI asserts Chrome is present before running these, so a skip
 * there is a real signal rather than a quiet pass.
 */
export const haveChrome = ((): boolean => {
	try {
		resolveChromePath(process.env.CHROME_PATH);
		return true;
	} catch {
		// The only failure mode is "no Chrome", which is the answer.
		return false;
	}
})();

/** A page the fixture server knows how to serve. */
export interface Route {
	/** Path, including the leading slash. */
	readonly path: string;
	readonly body: string;
	readonly type?: string;
	readonly status?: number;
	/** Held this long before answering, to keep a load in flight. */
	readonly delayMs?: number;
	readonly headers?: Readonly<Record<string, string>>;
}

/** A running fixture server, and how to reach it. */
export interface Fixture {
	readonly origin: string;
	/** An absolute URL for one of its routes. */
	url(path: string): string;
	close(): Promise<void>;
}

/**
 * A websocket endpoint the fixture will also answer on.
 *
 * Off unless asked for, so the suites that do not want one do not
 * pay for a second listener.
 */
export interface SocketRoute {
	readonly path: string;
	/** What to say to a client the moment it connects. */
	readonly greet?: string;
	/** How to answer whatever the client sends. */
	readonly reply?: (said: string) => string | undefined;
}

const HTML = "text/html; charset=utf-8";

/**
 * Serve a fixed set of routes on a loopback port.
 *
 * Port zero, so suites running in parallel cannot collide on a
 * number somebody picked.
 */
export async function serve(
	routes: readonly Route[],
	sockets: readonly SocketRoute[] = [],
): Promise<Fixture> {
	const byPath = new Map(routes.map((route) => [route.path, route]));
	const server: Server = createServer((request, response) => {
		const path = (request.url ?? "/").split("?")[0] ?? "/";
		const route = byPath.get(path);
		const answer = (): void => {
			if (!route) {
				response.writeHead(404, { "content-type": "text/plain" });
				response.end("no such fixture");
				return;
			}
			response.writeHead(route.status ?? 200, {
				"content-type": route.type ?? HTML,
				...route.headers,
			});
			response.end(route.body);
		};
		if (route?.delayMs) setTimeout(answer, route.delayMs);
		else answer();
	});

	const wsServers = sockets.map((route) => {
		const ws = new WebSocketServer({ server, path: route.path });
		ws.on("connection", (socket) => {
			if (route.greet !== undefined) socket.send(route.greet);
			socket.on("message", (data) => {
				const answer = route.reply?.(String(data));
				if (answer !== undefined) socket.send(answer);
			});
		});
		return ws;
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	return {
		origin,
		url: (path) => `${origin}${path}`,
		close: async () => {
			// A websocket server holds the http server open, so closing
			// the http server alone hangs until every client times out.
			for (const ws of wsServers) {
				for (const client of ws.clients) client.terminate();
				await new Promise<void>((resolve) => ws.close(() => resolve()));
			}
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		},
	};
}

/** Wrap a body in a document the browser will lay out normally. */
export function page(title: string, body: string, head = ""): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${head}
</head>
<body>${body}</body>
</html>`;
}

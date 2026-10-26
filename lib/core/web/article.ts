/**
 * Article extraction: the main content of a page's HTML, as markdown.
 *
 * Defuddle does its work synchronously, and its cost grows with about
 * the square of the page: measured on this machine, 250 kB held the
 * event loop for 3.6 seconds and 1.25 MB for 57. Run in the process
 * that asked, that is a pi with nothing moving, Escape included, and a
 * read whose own clock cannot fire because the clock is on the loop
 * being held.
 *
 * So each extraction runs in a worker thread of its own. The process
 * that asked stays free, a clock or a stop ends the extraction by
 * terminating the thread, and the hundred-odd megabytes jsdom builds
 * go with the thread once it is done. An extraction that is ended, or
 * that fails, finds no article, which a page read already copes with:
 * the bundle still has the inner text, the DOM and the screenshots.
 */

import { Worker } from "node:worker_threads";

/** Main content extracted from a page by defuddle. */
export interface Article {
	markdown: string;
	title: string;
	wordCount: number;
}

/** Below this word count, defuddle's output is treated as "no article". */
const MIN_ARTICLE_WORDS = 30;

/**
 * The longest one extraction may take before the page goes without an
 * article. An ordinary page takes well under a second, starting the
 * thread included; a page past this is one defuddle would take minutes
 * over.
 */
export const ARTICLE_WALL_MS = 20_000;

/** How an extraction can be ended before it finishes. */
export interface ExtractOptions {
	readonly signal?: AbortSignal;
	readonly wallMs?: number;
}

/** What the thread is handed: the page, and where its modules are. */
interface Job {
	readonly html: string;
	readonly url: string;
	readonly jsdom: string;
	readonly defuddle: string;
}

/**
 * The thread's whole program. It is source rather than a file beside
 * this one, because this module runs as TypeScript under the tests and
 * as JavaScript once built, and a sibling file would have to be found
 * under either name. The modules it needs are resolved here and handed
 * over as absolute URLs, so it finds the same ones whichever way this
 * module was loaded. A virtual console with no listeners keeps jsdom's
 * complaints about the page off the terminal pi draws on.
 */
const PROGRAM = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
	const { JSDOM, VirtualConsole } = await import(workerData.jsdom);
	const { Defuddle } = await import(workerData.defuddle);
	const dom = new JSDOM(workerData.html, {
		url: workerData.url,
		virtualConsole: new VirtualConsole(),
	});
	const result = await Defuddle(dom.window.document, workerData.url, {
		markdown: true,
		useAsync: false,
	});
	parentPort.postMessage(
		result
			? {
					markdown: result.contentMarkdown ?? result.content ?? "",
					title: result.title ?? "",
					wordCount: result.wordCount,
				}
			: null,
	);
})().catch(() => parentPort.postMessage(null));
`;

/**
 * Run defuddle over the page HTML to extract the main content as
 * markdown, resolving relative links against the final URL. Finds no
 * article when defuddle throws, finds too little to be a real article,
 * outlasts its clock or is stopped. Never rejects.
 */
export async function extractArticle(
	html: string,
	url: string,
	options: ExtractOptions = {},
): Promise<Article | null> {
	const { signal, wallMs = ARTICLE_WALL_MS } = options;
	if (signal?.aborted) return null;
	const found = await inThread(
		{
			html,
			url,
			jsdom: import.meta.resolve("jsdom"),
			defuddle: import.meta.resolve("defuddle/node"),
		},
		wallMs,
		signal,
	);
	if (!found || found.wordCount < MIN_ARTICLE_WORDS) return null;
	return found;
}

/** The thread's answer, or null once it fails, its clock runs out or it is stopped. */
function inThread(
	job: Job,
	wallMs: number,
	signal: AbortSignal | undefined,
): Promise<Article | null> {
	return new Promise((resolve) => {
		const worker = new Worker(PROGRAM, { eval: true, workerData: job });
		const finish = (article: Article | null) => {
			clearTimeout(clock);
			signal?.removeEventListener("abort", stop);
			resolve(article);
			// Terminating a thread that has already answered only frees it,
			// and one that will not end is no longer anybody's concern.
			worker.terminate().catch(() => undefined);
		};
		const stop = () => finish(null);
		const clock = setTimeout(stop, wallMs);
		signal?.addEventListener("abort", stop, { once: true });
		worker.once("message", (article: Article | null) => finish(article));
		worker.once("error", stop);
		worker.once("exit", stop);
	});
}

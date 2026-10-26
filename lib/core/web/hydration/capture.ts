/**
 * Reading the server render and the hydrated page side by side.
 *
 * The server's HTML is fetched from inside the page, so it
 * travels with the session's own cookies and headers, and it is
 * parsed with DOMParser, which builds a document without running
 * a single script: exactly what the browser had before hydration
 * ran. Both documents are reduced to the same compact shape,
 * text and tag counts, because the judgment belongs to the pure
 * side and whole DOM trees do not fit through a capture.
 */

/** Both renders, reduced to comparable shape. */
export interface HydrationCapture {
	readonly url: string;
	/** Whether the server render could be fetched at all. */
	readonly fetched: boolean;
	readonly status?: number;
	readonly serverTexts: readonly string[];
	readonly clientTexts: readonly string[];
	readonly serverTags: Readonly<Record<string, number>>;
	readonly clientTags: Readonly<Record<string, number>>;
}

/** Texts shorter than this are markup lint, not content. */
export const MIN_TEXT_CHARS = 3;

/** How many texts to carry per side. */
export const MAX_TEXTS = 500;

/** How much of each text to keep. */
export const MAX_TEXT_CHARS = 120;

/**
 * The expression that reads both renders.
 *
 * Async because the server render is a fetch; evaluate it with
 * awaitPromise. Scripts, styles and noscript are excluded from
 * both sides: they are machinery, not content, and noscript text
 * is visible in exactly one of the two renders by definition.
 */
export const HYDRATION_CAPTURE = `(async () => {
	const MIN_TEXT = ${MIN_TEXT_CHARS};
	const MAX_TEXTS = ${MAX_TEXTS};
	const MAX_CHARS = ${MAX_TEXT_CHARS};
	const MACHINERY = new Set(["script", "style", "noscript", "template"]);

	const textsOf = (root) => {
		const walker = document.createTreeWalker(
			root,
			NodeFilter.SHOW_TEXT,
			null,
		);
		const texts = [];
		while (walker.nextNode() && texts.length < MAX_TEXTS) {
			const node = walker.currentNode;
			const parent = node.parentElement;
			if (!parent) continue;
			if (MACHINERY.has(parent.tagName.toLowerCase())) continue;
			const text = (node.textContent || "")
				.replace(/\\s+/g, " ")
				.trim()
				.slice(0, MAX_CHARS);
			if (text.length >= MIN_TEXT) texts.push(text);
		}
		return texts;
	};

	const tagsOf = (root) => {
		const counts = {};
		for (const el of root.querySelectorAll("*")) {
			const tag = el.tagName.toLowerCase();
			if (MACHINERY.has(tag) || tag === "link" || tag === "meta") continue;
			counts[tag] = (counts[tag] || 0) + 1;
		}
		return counts;
	};

	let fetched = false;
	let status;
	let serverTexts = [];
	let serverTags = {};
	try {
		const response = await fetch(location.href, {
			headers: { accept: "text/html" },
			credentials: "include",
			cache: "no-store",
		});
		status = response.status;
		if (response.ok) {
			const html = await response.text();
			const server = new DOMParser().parseFromString(html, "text/html");
			const root = server.body || server.documentElement;
			serverTexts = textsOf(root);
			serverTags = tagsOf(root);
			fetched = true;
		}
	} catch (error) {
		// fetched stays false, which the judge reports honestly.
	}

	const live = document.body || document.documentElement;
	return {
		url: location.href,
		fetched,
		...(status === undefined ? {} : { status }),
		serverTexts,
		serverTags,
		clientTexts: textsOf(live),
		clientTags: tagsOf(live),
	};
})()`;

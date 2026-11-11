// Run in the page, sent by capture.ts's HYDRATION_CAPTURE, which says what it does.
async ({ MIN_TEXT, MAX_TEXTS, MAX_CHARS }) => {
	const MACHINERY = new Set(["script", "style", "noscript", "template"]);

	const textsOf = (root) => {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
		const texts = [];
		while (walker.nextNode() && texts.length < MAX_TEXTS) {
			const node = walker.currentNode;
			const parent = node.parentElement;
			if (!parent) continue;
			if (MACHINERY.has(parent.tagName.toLowerCase())) continue;
			const text = (node.textContent || "")
				.replace(/\s+/g, " ")
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
	} catch {
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
};

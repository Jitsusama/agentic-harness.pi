// Run in the page, sent by typography.ts's TYPOGRAPHY_CAPTURE, which says what it does.
({ BODY_FLOOR }) => {
	const MAX_TEXT = 80;

	const selectorFor = (el) => {
		const tag = el.tagName.toLowerCase();
		if (el.id) return `#${el.id}`;
		const hook = el.getAttribute("data-testid");
		if (hook) return `${tag}[data-testid="${hook}"]`;
		const first = el.classList[0];
		if (first) return `${tag}.${first}`;
		return tag;
	};

	const visualLines = (element) => {
		const walker = document.createTreeWalker(
			element,
			NodeFilter.SHOW_TEXT,
			null,
		);
		const nodes = [];
		while (walker.nextNode()) {
			if (walker.currentNode.textContent.trim()) {
				nodes.push(walker.currentNode);
			}
		}
		const range = document.createRange();
		const lines = [];
		let top = null;
		let height = 0;
		let words = 0;
		let left = Number.POSITIVE_INFINITY;
		let right = Number.NEGATIVE_INFINITY;
		let text = "";
		const flush = () => {
			if (words > 0) {
				lines.push({ words, width: right - left, text });
			}
			words = 0;
			left = Number.POSITIVE_INFINITY;
			right = Number.NEGATIVE_INFINITY;
			text = "";
		};
		for (const node of nodes) {
			const content = node.textContent;
			const matcher = /\S+/g;
			let match = matcher.exec(content);
			while (match) {
				range.setStart(node, match.index);
				range.setEnd(node, match.index + match[0].length);
				const rect = range.getBoundingClientRect();
				if (rect.width > 0 || rect.height > 0) {
					const sameLine =
						top !== null && Math.abs(rect.top - top) <= height / 2;
					if (!sameLine) {
						flush();
						top = rect.top;
						height = rect.height;
					}
					words += 1;
					left = Math.min(left, rect.left);
					right = Math.max(right, rect.right);
					if (text.length < MAX_TEXT) {
						text = (text ? `${text} ` : "") + match[0];
					}
				}
				match = matcher.exec(content);
			}
		}
		flush();
		return lines;
	};

	const wrapStyle = (el) => {
		const style = getComputedStyle(el);
		return style.textWrap || style.textWrapStyle || "";
	};

	const candidates = document.querySelectorAll(
		"p, h1, h2, h3, h4, h5, h6, figcaption",
	);
	const blocks = [];
	for (const el of candidates) {
		if (el.getClientRects().length === 0) continue;
		const tag = el.tagName.toLowerCase();
		const textLength = (el.innerText || "").trim().length;
		if (textLength === 0) continue;
		// Headings matter most and are short; body text below the
		// floor has no room for a wrap worth judging.
		const heading = tag[0] === "h";
		if (!heading && textLength < BODY_FLOOR) continue;
		// The author already asked the browser to mind the wrapping.
		const wrap = wrapStyle(el);
		if (wrap.includes("balance") || wrap.includes("pretty")) continue;
		// Text inside a collapsed disclosure is not laid out.
		const details = el.closest("details");
		if (details && !details.open) continue;
		const lines = visualLines(el);
		const last = lines[lines.length - 1];
		if (!last) continue;
		blocks.push({
			selector: selectorFor(el),
			tag,
			textLength,
			containerWidth: el.clientWidth,
			lineCount: lines.length,
			lastLine: {
				words: last.words,
				width: last.width,
				text: last.text.slice(0, MAX_TEXT),
			},
		});
	}
	return blocks;
};

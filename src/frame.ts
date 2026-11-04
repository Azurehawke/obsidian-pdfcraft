// Runs PdfCraft's web build in an iframe on the host page's own origin.
//
// PdfCraft's host bridge (apps/pdfcraft-web, `mod host`) only talks to a parent on its own
// origin. Obsidian serves plugin files from a different origin than its window, so the app's
// files are turned into blob: URLs instead: a blob: URL belongs to the page that made it, so the
// iframe, its scripts and the .wasm all share Obsidian's origin. A blob: URL can't carry a query,
// so the bridge's settings (`host`, `author`) go on `window.pdfcraftParams` before PdfCraft starts.
//
// No Obsidian APIs here: this file is also loaded in a plain browser by the tests.

import type { Bundle } from "./bundle";

export interface FrameUrls {
	/** The iframe's page. */
	page: string;
	/** Every blob: URL made for this bundle, to revoke when it's no longer used. */
	all: string[];
}

const TYPES: Record<string, string> = {
	js: "text/javascript",
	mjs: "text/javascript",
	wasm: "application/wasm",
	css: "text/css",
	html: "text/html",
	json: "application/json",
	svg: "image/svg+xml",
	png: "image/png",
	ico: "image/x-icon",
	ttf: "font/ttf",
	otf: "font/otf",
	woff: "font/woff",
	woff2: "font/woff2",
};

function typeOf(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return TYPES[ext] ?? "application/octet-stream";
}

/** Resolves `spec` (a relative import such as "./snippets/x/inline0.js") against the file `from`. */
function resolve(from: string, spec: string): string {
	const parts = from.split("/").slice(0, -1);
	for (const p of spec.split("/")) {
		if (p === "." || p === "") continue;
		if (p === "..") parts.pop();
		else parts.push(p);
	}
	return parts.join("/");
}

/**
 * Blob URLs for the bundle's files, with the JavaScript modules' relative imports rewritten to
 * point at the other files' blob URLs (wasm-bindgen glue imports its `snippets/` this way).
 */
export function makeFrameUrls(bundle: Bundle, params: Record<string, string>): FrameUrls {
	const all: string[] = [];
	const urls = new Map<string, string>();
	const decoder = new TextDecoder();
	const blob = (data: BlobPart, type: string) => {
		const url = URL.createObjectURL(new Blob([data], { type }));
		all.push(url);
		return url;
	};
	const isModule = (p: string) => /\.m?js$/i.test(p);

	// Modules import each other; give the leaves URLs first (snippets import nothing).
	const pending = [...bundle.files.keys()];
	const urlFor = (path: string, seen: Set<string>): string => {
		const done = urls.get(path);
		if (done) return done;
		const data = bundle.files.get(path);
		if (!data) throw new Error(`PdfCraft app bundle has no ${path}`);
		let url: string;
		if (isModule(path) && !seen.has(path)) {
			seen.add(path);
			const source = decoder.decode(data).replace(
				/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\2/g,
				(match, lead: string, quote: string, spec: string) => {
					const target = resolve(path, spec);
					return bundle.files.has(target) ? `${lead}${quote}${urlFor(target, seen)}${quote}` : match;
				},
			);
			url = blob(source, "text/javascript");
		} else {
			url = blob(data as BlobPart, typeOf(path));
		}
		urls.set(path, url);
		return url;
	};
	for (const p of pending) if (isModule(p)) urlFor(p, new Set());

	const js = urlFor(bundle.header.entry.js, new Set());
	const wasm = urlFor(bundle.header.entry.wasm, new Set());

	// The boot script and styles are files too, not inline: an iframe made from a blob: URL
	// inherits its creator's content security policy, which may refuse inline scripts.
	const boot = blob(
		`window.pdfcraftParams = ${JSON.stringify(params)};\n` +
			`import(${JSON.stringify(js)})\n` +
			`  .then((glue) => glue.default({ module_or_path: ${JSON.stringify(wasm)} }))\n` +
			`  .catch((e) => parent.postMessage({ type: "pdfcraft:failed", error: String(e && e.message || e) }, location.origin));\n`,
		"text/javascript",
	);
	const css = blob(bundle.header.css || "html, body { margin: 0; height: 100%; overflow: hidden; } canvas { width: 100%; height: 100%; display: block; outline: none; }", "text/css");
	const page = blob(
		`<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
			`<meta name="viewport" content="width=device-width, initial-scale=1">` +
			`<title>PdfCraft</title><link rel="stylesheet" href="${css}"></head>` +
			`<body><canvas id="pdfcraft"></canvas><script type="module" src="${boot}"></script></body></html>`,
		"text/html",
	);
	return { page, all };
}

export function revokeFrameUrls(urls: FrameUrls) {
	for (const u of urls.all) URL.revokeObjectURL(u);
}

/** What the iframe's PdfCraft says (apps/pdfcraft-web `mod host`). */
export type BridgeMessage =
	| { type: "pdfcraft:ready"; version?: string }
	| { type: "pdfcraft:save"; name: string; saveAs: boolean; bytes: ArrayBuffer }
	| { type: "pdfcraft:dirty"; dirty: boolean }
	| { type: "pdfcraft:failed"; error: string };

export interface BridgeHandlers {
	ready(version: string): void;
	save(name: string, bytes: ArrayBuffer, saveAs: boolean): void;
	dirty(dirty: boolean): void;
	failed(error: string): void;
}

/**
 * Listens to one iframe's PdfCraft on `win` (the window the iframe sits in). Returns a function
 * that stops listening.
 */
export function listen(win: Window, frame: HTMLIFrameElement, handlers: BridgeHandlers): () => void {
	const onMessage = (event: MessageEvent) => {
		if (event.source !== frame.contentWindow) return;
		const msg = event.data as Partial<BridgeMessage> | null;
		if (!msg || typeof msg !== "object") return;
		switch (msg.type) {
			case "pdfcraft:ready":
				handlers.ready(typeof msg.version === "string" ? msg.version : "");
				break;
			case "pdfcraft:save":
				if (msg.bytes instanceof ArrayBuffer) handlers.save(typeof msg.name === "string" ? msg.name : "", msg.bytes, !!msg.saveAs);
				break;
			case "pdfcraft:dirty":
				handlers.dirty(!!msg.dirty);
				break;
			case "pdfcraft:failed":
				handlers.failed(typeof msg.error === "string" ? msg.error : "unknown error");
				break;
		}
	};
	win.addEventListener("message", onMessage);
	return () => win.removeEventListener("message", onMessage);
}

/** Hands a PDF to the iframe's PdfCraft; it opens in a tab inside PdfCraft. */
export function openInFrame(frame: HTMLIFrameElement, name: string, bytes: ArrayBuffer) {
	const target = frame.contentWindow;
	if (!target) return;
	// The iframe is on this page's origin (blob: URL); "*" only when the origin is opaque.
	const origin = frame.ownerDocument.defaultView?.origin;
	target.postMessage({ type: "pdfcraft:open", name, bytes }, origin && origin !== "null" ? origin : "*", [bytes]);
}

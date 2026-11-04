// PdfCraft's web build packed into one file (scripts/pack-app.mjs), so the plugin downloads,
// checks and syncs a single file instead of a folder.
//
// Layout: the 12 bytes "PDFCRAFTAPP1", a 4-byte little-endian header length, the header (UTF-8
// JSON, BundleHeader), then each file's bytes in header order.

export const MAGIC = "PDFCRAFTAPP1";

export interface BundleFile {
	/** Path inside the web build, with "/" separators and no leading "./". */
	path: string;
	size: number;
}

export interface BundleHeader {
	/** PdfCraft's version, from its Cargo.toml. */
	pdfcraftVersion: string;
	/** The commit of PdfCraft the web build came from. */
	pdfcraftCommit: string;
	/** The wasm-bindgen glue module and the app's .wasm, as index.html loads them. */
	entry: { js: string; wasm: string };
	/** The page styles from index.html (background, full-size canvas). */
	css: string;
	files: BundleFile[];
}

export interface Bundle {
	header: BundleHeader;
	files: Map<string, Uint8Array>;
}

/** Most files and header bytes a bundle may have: a damaged file is refused, not followed. */
const MAX_FILES = 2000;
const MAX_HEADER = 4 * 1024 * 1024;

export function parseBundle(data: ArrayBuffer): Bundle {
	const bytes = new Uint8Array(data);
	const magic = new TextDecoder().decode(bytes.subarray(0, MAGIC.length));
	if (magic !== MAGIC) throw new Error("not a PdfCraft app bundle");
	const view = new DataView(data);
	const headerStart = MAGIC.length + 4;
	if (data.byteLength < headerStart) throw new Error("PdfCraft app bundle is truncated");
	const headerLen = view.getUint32(MAGIC.length, true);
	if (headerLen > MAX_HEADER || headerStart + headerLen > data.byteLength) throw new Error("PdfCraft app bundle header is damaged");
	const header = JSON.parse(new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLen))) as BundleHeader;
	if (!header || !Array.isArray(header.files) || header.files.length > MAX_FILES || !header.entry) {
		throw new Error("PdfCraft app bundle header is damaged");
	}
	const files = new Map<string, Uint8Array>();
	let at = headerStart + headerLen;
	for (const f of header.files) {
		if (typeof f.path !== "string" || !Number.isSafeInteger(f.size) || f.size < 0 || at + f.size > data.byteLength) {
			throw new Error("PdfCraft app bundle is truncated");
		}
		files.set(f.path, bytes.subarray(at, at + f.size));
		at += f.size;
	}
	if (!files.has(header.entry.js) || !files.has(header.entry.wasm)) throw new Error("PdfCraft app bundle is missing its entry files");
	return { header, files };
}

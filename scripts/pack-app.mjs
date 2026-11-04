// Packs PdfCraft's web build (Trunk's dist/web) into the single file the plugin downloads.
//
//   node scripts/pack-app.mjs <pdfcraft>/dist/web [--out pdfcraft-web.bin] [--commit SHA] [--version V]
//
// Writes the bundle (src/bundle.ts describes the layout) and a gzipped copy (the release asset),
// and prints the bundle's SHA-256, which a release build of the plugin pins.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dist = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
if (!dist) {
	console.error("Usage: node scripts/pack-app.mjs <pdfcraft>/dist/web [--out pdfcraft-web.bin] [--commit SHA] [--version V]");
	process.exit(2);
}
const out = opt("--out", "pdfcraft-web.bin");

const index = readFileSync(join(dist, "index.html"), "utf8");
const clean = (p) => p.replace(/^\/?(\.\/)+/, "").replace(/^\//, "");
const js = /from\s*['"]([^'"]+\.js)['"]/.exec(index)?.[1];
const wasm = /module_or_path\s*:\s*['"]([^'"]+\.wasm)['"]/.exec(index)?.[1] ?? /href=["']([^"']+_bg\.wasm)["']/.exec(index)?.[1];
if (!js || !wasm) {
	console.error("Couldn't find the app's .js and .wasm in index.html; is this Trunk's output?");
	process.exit(1);
}
const css = [...index.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1].trim()).join("\n");

const files = [];
const walk = (dir) => {
	for (const name of readdirSync(dir).sort()) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full);
		else {
			const path = relative(dist, full).split(sep).join("/");
			if (path !== "index.html") files.push({ path, data: readFileSync(full) });
		}
	}
};
walk(dist);

const header = {
	pdfcraftVersion: opt("--version", ""),
	pdfcraftCommit: opt("--commit", ""),
	entry: { js: clean(js), wasm: clean(wasm) },
	css,
	files: files.map((f) => ({ path: f.path, size: f.data.length })),
};
for (const e of [header.entry.js, header.entry.wasm]) {
	if (!files.some((f) => f.path === e)) {
		console.error(`index.html names ${e}, which isn't in ${dist}`);
		process.exit(1);
	}
}

const head = Buffer.from(JSON.stringify(header), "utf8");
const len = Buffer.alloc(4);
len.writeUInt32LE(head.length);
const bundle = Buffer.concat([Buffer.from("PDFCRAFTAPP1", "utf8"), len, head, ...files.map((f) => f.data)]);
writeFileSync(out, bundle);
const gz = gzipSync(bundle, { level: 9 });
writeFileSync(`${out}.gz`, gz);

const sha = createHash("sha256").update(bundle).digest("hex");
const mb = (n) => (n / 1048576).toFixed(1);
console.log(`${files.length} files, entry ${header.entry.js} + ${header.entry.wasm}`);
console.log(`${out}: ${mb(bundle.length)} MB, ${out}.gz: ${mb(gz.length)} MB`);
console.log(`sha256 ${sha}`);

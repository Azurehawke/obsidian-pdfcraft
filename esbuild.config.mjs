// Bundles the plugin into main.js.
//
//   node esbuild.config.mjs              development build (watches; loads pdfcraft-dev.bin from the plugin folder)
//   node esbuild.config.mjs production   release build (pins pdfcraft-web.bin made by scripts/pack-app.mjs)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import esbuild from "esbuild";

const prod = process.argv[2] === "production";
const bundlePath = "pdfcraft-web.bin";

// A release build pins the exact PdfCraft it was built with: the plugin downloads that file and
// refuses any other. A development build leaves this empty and loads pdfcraft-dev.bin as-is.
let appSha256 = "";
let appSizeMb = 0;
if (prod) {
	if (!existsSync(bundlePath)) {
		console.error("No pdfcraft-web.bin: run `npm run pack -- <pdfcraft>/dist/web` first.");
		process.exit(1);
	}
	appSha256 = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");
	appSizeMb = existsSync(`${bundlePath}.gz`) ? Math.max(1, Math.round(statSync(`${bundlePath}.gz`).size / 1048576)) : 0;
	console.log(`PdfCraft bundle sha256 ${appSha256}, download ~${appSizeMb} MB`);
}

const repo = process.env.GITHUB_REPOSITORY || "Azurehawke/obsidian-pdfcraft";

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	outfile: "main.js",
	define: {
		APP_SHA256: JSON.stringify(appSha256),
		APP_REPO: JSON.stringify(repo),
		APP_SIZE_MB: String(appSizeMb),
	},
});

if (prod) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}

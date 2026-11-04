// Loads PdfCraft's web app once per session.
//
// A release build knows the SHA-256 of the exact app bundle it was built with (scripts/pack-app.mjs).
// The bundle lives in the plugin folder as pdfcraft-<plugin version>.bin; when it's missing (first
// use, or after an update) it's downloaded from this plugin's GitHub release of the same version,
// unpacked, checked against that fingerprint, and saved. Syncthing (or any vault sync) then
// carries the file to other devices, which find it already in place.
//
// A development build (`npm run dev`) has no fingerprint and loads pdfcraft-dev.bin from the
// plugin folder without checks.

import { normalizePath, requestUrl, type DataAdapter, type Plugin } from "obsidian";
import { parseBundle, type Bundle } from "./bundle";

declare const APP_SHA256: string;
declare const APP_REPO: string;
declare const APP_SIZE_MB: number;

const ASSET = "pdfcraft-web.bin.gz";

export type AppStatus = "checking" | "downloading" | "starting";

export class AppLoader {
	private loading: Promise<Bundle> | null = null;
	private listeners = new Set<(s: AppStatus) => void>();

	constructor(private plugin: Plugin) {}

	/** About how big the one-time download is, in MB (0 in a development build). */
	static get downloadSizeMb(): number {
		return APP_SIZE_MB;
	}

	/** The app bundle, loading (and downloading) it on first call. A failed load is retried on the next call. */
	get(onStatus?: (s: AppStatus) => void): Promise<Bundle> {
		if (onStatus) this.listeners.add(onStatus);
		if (!this.loading) {
			this.loading = this.load().catch((e) => {
				this.loading = null;
				throw e;
			});
		}
		const done = () => {
			if (onStatus) this.listeners.delete(onStatus);
		};
		this.loading.then(done, done);
		return this.loading;
	}

	/** Whether this device already has the app (no download needed). */
	async isDownloaded(): Promise<boolean> {
		if (!APP_SHA256) return true;
		return await this.plugin.app.vault.adapter.exists(this.file());
	}

	/** Deletes the downloaded app from this device (it downloads again on next use). */
	async remove(): Promise<void> {
		this.loading = null;
		const adapter = this.plugin.app.vault.adapter;
		await removeBundles(adapter, this.dir(), null);
	}

	private status(s: AppStatus) {
		for (const l of this.listeners) l(s);
	}

	private dir(): string {
		return this.plugin.manifest.dir ?? normalizePath(`${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`);
	}

	private file(): string {
		return normalizePath(`${this.dir()}/pdfcraft-${this.plugin.manifest.version}.bin`);
	}

	private async load(): Promise<Bundle> {
		const adapter = this.plugin.app.vault.adapter;
		let bytes: ArrayBuffer;

		if (!APP_SHA256) {
			const dev = normalizePath(`${this.dir()}/pdfcraft-dev.bin`);
			if (!(await adapter.exists(dev))) {
				throw new Error(`Development build: run \`npm run pack -- <pdfcraft>/dist/web\` and copy pdfcraft-dev.bin to ${dev}.`);
			}
			bytes = await adapter.readBinary(dev);
		} else {
			this.status("checking");
			const file = this.file();
			let cached: ArrayBuffer | null = null;
			if (await adapter.exists(file)) {
				const b = await adapter.readBinary(file);
				// A partial or wrong file (an interrupted sync, say) is fetched again.
				if ((await sha256(b)) === APP_SHA256) cached = b;
			}
			if (cached) {
				bytes = cached;
			} else {
				this.status("downloading");
				bytes = await download(this.plugin.manifest.version);
				await adapter.writeBinary(file, bytes);
				await removeBundles(adapter, this.dir(), file);
			}
		}

		this.status("starting");
		return parseBundle(bytes);
	}
}

async function download(version: string): Promise<ArrayBuffer> {
	const url = `https://github.com/${APP_REPO}/releases/download/${version}/${ASSET}`;
	let res;
	try {
		res = await requestUrl({ url, method: "GET", throw: false });
	} catch (e) {
		throw new Error(`Couldn't download PdfCraft. Check your connection and try again. (${errorText(e)})`);
	}
	if (res.status !== 200) {
		throw new Error(`Couldn't download PdfCraft (HTTP ${res.status} from ${url}).`);
	}
	const raw = await gunzip(res.arrayBuffer);
	if ((await sha256(raw)) !== APP_SHA256) {
		throw new Error("The downloaded PdfCraft didn't match this plugin version, so it wasn't used. Try again, or reinstall the plugin.");
	}
	return raw;
}

async function gunzip(data: ArrayBuffer): Promise<ArrayBuffer> {
	if (typeof DecompressionStream === "undefined") {
		throw new Error("This device can't unpack PdfCraft (no DecompressionStream).");
	}
	const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
	return await new Response(stream).arrayBuffer();
}

async function sha256(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deletes app bundles other than `keep` (earlier versions, sync-conflict copies). */
async function removeBundles(adapter: DataAdapter, dir: string, keep: string | null) {
	try {
		const list = await adapter.list(dir);
		for (const f of list.files) {
			const name = f.split("/").pop() ?? "";
			if (f !== keep && /^pdfcraft-.*\.bin$/.test(name) && name !== "pdfcraft-dev.bin") await adapter.remove(f);
		}
	} catch {
		// Leftovers only cost disk space; never fail a load over them.
	}
}

export function errorText(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}

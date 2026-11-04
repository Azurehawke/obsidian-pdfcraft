// A tab showing one vault PDF in PdfCraft.
//
// PdfCraft runs in an iframe (frame.ts) and gets the file's bytes when it says it's ready.
// When you save in PdfCraft (Ctrl+S, or File › Save), the bytes come back and are written over the
// vault file; Save As asks for a new name and writes a new file next to it. Unsaved changes
// show as a dot in the tab's title.

import { FileView, Modal, Notice, Setting, TFile, normalizePath, type WorkspaceLeaf } from "obsidian";
import { AppLoader, errorText, type AppStatus } from "./app";
import { listen, openInFrame, type FrameUrls } from "./frame";
import type PdfCraftPlugin from "./main";

export const VIEW_TYPE = "pdfcraft";

/** How long PdfCraft gets to start before the tab says something is wrong. */
const START_TIMEOUT_MS = 60_000;

export class PdfCraftView extends FileView {
	override navigation = true;
	private frame: HTMLIFrameElement | null = null;
	private urls: FrameUrls | null = null;
	private stopListening: (() => void) | null = null;
	private statusEl: HTMLElement | null = null;
	private startTimer: number | null = null;
	private dirty = false;
	/** When this tab last wrote its file, so the change it causes doesn't reload it. */
	lastOwnWrite = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: PdfCraftPlugin,
	) {
		super(leaf);
	}

	override getViewType(): string {
		return VIEW_TYPE;
	}

	override getIcon(): string {
		return "pencil";
	}

	override getDisplayText(): string {
		const name = this.file?.basename ?? "PdfCraft";
		return this.dirty ? `● ${name}` : name;
	}

	override canAcceptExtension(extension: string): boolean {
		return extension.toLowerCase() === "pdf";
	}

	override async onOpen() {
		this.contentEl.addClass("pdfcraft-view");
		this.addAction("book-open", "Open in Obsidian's PDF viewer", () => {
			if (this.file) void this.plugin.openNative(this.leaf, this.file);
		});
	}

	override async onLoadFile(file: TFile): Promise<void> {
		await this.start(file);
	}

	override async onUnloadFile(file: TFile): Promise<void> {
		if (this.dirty) {
			new Notice(`PdfCraft: unsaved changes to ${file.name} were not saved.`, 8000);
		}
		this.stop();
	}

	override async onClose() {
		this.stop();
	}

	/** The file changed on disk (sync, another app): show the new version if nothing is unsaved. */
	async reloadFromDisk() {
		if (!this.file || this.dirty) return;
		await this.start(this.file);
	}

	private setStatus(text: string | null, error = false) {
		if (!text) {
			this.statusEl?.remove();
			this.statusEl = null;
			return;
		}
		if (!this.statusEl) this.statusEl = this.contentEl.createDiv({ cls: "pdfcraft-status" });
		this.statusEl.toggleClass("pdfcraft-error", error);
		this.statusEl.setText(text);
	}

	private setDirty(dirty: boolean) {
		if (dirty === this.dirty) return;
		this.dirty = dirty;
		// Not in the public API: refreshes the tab title. Harmless if missing.
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
	}

	private stop() {
		if (this.startTimer !== null) window.clearTimeout(this.startTimer);
		this.startTimer = null;
		this.stopListening?.();
		this.stopListening = null;
		this.frame?.remove();
		this.frame = null;
		if (this.urls) this.plugin.releaseFrameUrls(this.urls);
		this.urls = null;
		this.setDirty(false);
	}

	private async start(file: TFile) {
		this.stop();
		const loadingText: Record<AppStatus, string> = {
			checking: "Starting PdfCraft…",
			downloading: AppLoader.downloadSizeMb
				? `Downloading PdfCraft (one time, about ${AppLoader.downloadSizeMb} MB)…`
				: "Downloading PdfCraft (one time)…",
			starting: "Starting PdfCraft…",
		};
		this.setStatus("Starting PdfCraft…");
		let bundle;
		try {
			bundle = await this.plugin.loader.get((s) => this.setStatus(loadingText[s]));
		} catch (e) {
			this.setStatus(errorText(e), true);
			return;
		}
		if (this.file !== file) return; // another file was opened meanwhile

		const params: Record<string, string> = { host: "parent" };
		const author = this.plugin.settings.author.trim();
		if (author) params.author = author;
		this.urls = this.plugin.frameUrls(bundle, params);

		const frame = this.contentEl.createEl("iframe", { cls: "pdfcraft-frame", attr: { title: "PdfCraft", allow: "clipboard-read; clipboard-write; fullscreen" } });
		this.frame = frame;
		const win = this.contentEl.win;
		this.stopListening = listen(win, frame, {
			ready: () => void this.sendFile(file),
			save: (name, bytes, saveAs) => void this.save(name, bytes, saveAs),
			dirty: (d) => this.setDirty(d),
			failed: (error) => {
				this.setStatus(`PdfCraft couldn't start: ${error}`, true);
				frame.addClass("pdfcraft-hidden");
			},
		});
		this.startTimer = window.setTimeout(() => {
			this.setStatus("PdfCraft is taking long to start. If this stays, close the tab and open the PDF again.", true);
		}, START_TIMEOUT_MS);
		frame.src = this.urls.page;
	}

	private async sendFile(file: TFile) {
		if (this.startTimer !== null) window.clearTimeout(this.startTimer);
		this.startTimer = null;
		if (!this.frame) return;
		try {
			const bytes = await this.app.vault.readBinary(file);
			openInFrame(this.frame, file.name, bytes);
			this.setStatus(null);
		} catch (e) {
			this.setStatus(`Couldn't read ${file.path}: ${errorText(e)}`, true);
		}
	}

	private async save(name: string, bytes: ArrayBuffer, saveAs: boolean) {
		const file = this.file;
		if (!file) return;
		try {
			if (!saveAs) {
				this.lastOwnWrite = Date.now();
				await this.app.vault.modifyBinary(file, bytes);
				new Notice(`Saved ${file.name}`, 2000);
				return;
			}
			const suggested = name && name.toLowerCase().endsWith(".pdf") && name !== file.name ? name : `${file.basename} copy.pdf`;
			const chosen = await askName(this, suggested);
			if (!chosen) return;
			const folder = file.parent?.path ?? "";
			const path = normalizePath(folder && folder !== "/" ? `${folder}/${chosen}` : chosen);
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				if (existing === file) this.lastOwnWrite = Date.now();
				await this.app.vault.modifyBinary(existing, bytes);
			} else if (existing) {
				throw new Error(`${path} is a folder`);
			} else {
				await this.app.vault.createBinary(path, bytes);
			}
			new Notice(`Saved ${path}`, 3000);
		} catch (e) {
			new Notice(`PdfCraft: couldn't save: ${errorText(e)}`, 8000);
		}
	}
}

/** Asks for a file name for Save As (adds .pdf when it's missing). */
function askName(view: PdfCraftView, suggested: string): Promise<string | null> {
	return new Promise((resolve) => {
		const modal = new Modal(view.app);
		let value = suggested;
		let done = false;
		const finish = (v: string | null) => {
			if (done) return;
			done = true;
			// Resolve first: closing hands focus back to the PdfCraft frame, which can throw in
			// Obsidian's Modal.close and would otherwise leave Save As waiting forever.
			resolve(v);
			try {
				modal.close();
			} catch {
				// The modal is gone either way.
			}
		};
		modal.titleEl.setText("Save a copy as");
		new Setting(modal.contentEl).setName("File name").setDesc("Saved in the same folder as the PDF.").addText((t) => {
			t.setValue(value).onChange((v) => (value = v));
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") finish(clean(value));
			});
			window.setTimeout(() => t.inputEl.select(), 0);
		});
		new Setting(modal.contentEl)
			.addButton((b) => b.setButtonText("Save").setCta().onClick(() => finish(clean(value))))
			.addButton((b) => b.setButtonText("Cancel").onClick(() => finish(null)));
		modal.onClose = () => finish(null);
		modal.open();
	});
}

function clean(name: string): string | null {
	const base = name.trim().replace(/[\\/:*?"<>|]/g, "-");
	if (!base) return null;
	return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

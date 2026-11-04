import { ItemView, Notice, Plugin, PluginSettingTab, Setting, TFile, debounce, type App, type WorkspaceLeaf } from "obsidian";
import { AppLoader, errorText } from "./app";
import type { Bundle } from "./bundle";
import { makeFrameUrls, revokeFrameUrls, type FrameUrls } from "./frame";
import { PdfCraftView, VIEW_TYPE } from "./view";

/** Obsidian's own PDF view. */
const NATIVE_PDF = "pdf";
/** Per-device setting (kept in this device's local storage, not in the synced plugin data). */
const OPEN_BY_DEFAULT = "pdfcraft-open-by-default";

interface Settings {
	/** Name PdfCraft signs comments with (until you choose one in PdfCraft itself). */
	author: string;
}

const DEFAULTS: Settings = { author: "" };

export default class PdfCraftPlugin extends Plugin {
	override settings: Settings = { ...DEFAULTS };
	loader!: AppLoader;
	/** PDF tabs that already have the Open in PdfCraft button. */
	private withButton = new WeakSet<object>();
	/** Leaves switched to Obsidian's viewer on purpose: "open by default" leaves them alone for that file. */
	private keepNative = new WeakMap<WorkspaceLeaf, string>();
	/** blob: URLs per app bundle and settings, shared by the tabs using them. */
	private frames = new Map<string, { urls: FrameUrls; users: number }>();

	override async onload() {
		await this.loadSettings();
		this.loader = new AppLoader(this);
		this.registerView(VIEW_TYPE, (leaf) => new PdfCraftView(leaf, this));
		this.addSettingTab(new PdfCraftSettings(this.app, this));

		this.addCommand({
			id: "open-in-pdfcraft",
			name: "Open current PDF in PdfCraft",
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				const file = leaf?.view.getViewType() === NATIVE_PDF ? this.fileOf(leaf) : null;
				if (!leaf || !file) return false;
				if (!checking) void this.openInPdfCraft(leaf, file);
				return true;
			},
		});
		this.addCommand({
			id: "open-in-obsidian-viewer",
			name: "Open current PDF in Obsidian's viewer",
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				const view = leaf?.view;
				if (!leaf || !(view instanceof PdfCraftView) || !view.file) return false;
				if (!checking) void this.openNative(leaf, view.file);
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
				if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") return;
				menu.addItem((item) =>
					item
						.setTitle("Open in PdfCraft")
						.setIcon("pencil")
						.onClick(() => void this.openInPdfCraft(leaf && leaf.view.getViewType() === NATIVE_PDF ? leaf : this.app.workspace.getLeaf(false), file)),
				);
			}),
		);

		// A button on every PDF tab, and "open by default" on this device.
		const onLayout = () => this.decoratePdfTabs();
		this.registerEvent(this.app.workspace.on("layout-change", onLayout));
		this.registerEvent(this.app.workspace.on("active-leaf-change", onLayout));
		this.app.workspace.onLayoutReady(onLayout);

		// A PDF changed on disk (sync, another app) reloads its PdfCraft tabs without unsaved work.
		const reload = debounce(
			(path: string) => {
				for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
					const view = leaf.view;
					if (view instanceof PdfCraftView && view.file?.path === path && Date.now() - view.lastOwnWrite > 5000) void view.reloadFromDisk();
				}
			},
			1000,
			true,
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension.toLowerCase() === "pdf") reload(file.path);
			}),
		);
	}

	override onunload() {
		for (const { urls } of this.frames.values()) revokeFrameUrls(urls);
		this.frames.clear();
	}

	async loadSettings() {
		this.settings = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) };
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	get openByDefault(): boolean {
		return this.app.loadLocalStorage(OPEN_BY_DEFAULT) === "1";
	}

	set openByDefault(on: boolean) {
		this.app.saveLocalStorage(OPEN_BY_DEFAULT, on ? "1" : null);
		if (on) this.decoratePdfTabs();
	}

	private fileOf(leaf: WorkspaceLeaf): TFile | null {
		const file = (leaf.view as { file?: unknown }).file;
		return file instanceof TFile ? file : null;
	}

	/** Adds the button to PDF tabs that don't have it yet, and switches them when "open by default" is on. */
	private decoratePdfTabs() {
		const byDefault = this.openByDefault;
		for (const leaf of this.app.workspace.getLeavesOfType(NATIVE_PDF)) {
			const view = leaf.view;
			const file = this.fileOf(leaf);
			if (!file) continue;
			if (byDefault && this.keepNative.get(leaf) !== file.path) {
				void this.openInPdfCraft(leaf, file);
				continue;
			}
			if (!(view instanceof ItemView) || this.withButton.has(view)) continue;
			this.withButton.add(view);
			view.addAction("pencil", "Open in PdfCraft", () => {
				const current = this.fileOf(leaf);
				if (current) void this.openInPdfCraft(leaf, current);
			});
		}
	}

	async openInPdfCraft(leaf: WorkspaceLeaf, file: TFile) {
		this.keepNative.delete(leaf);
		try {
			await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
		} catch (e) {
			new Notice(`PdfCraft: couldn't open ${file.name}: ${errorText(e)}`);
		}
	}

	async openNative(leaf: WorkspaceLeaf, file: TFile) {
		this.keepNative.set(leaf, file.path);
		await leaf.setViewState({ type: NATIVE_PDF, state: { file: file.path }, active: true });
	}

	/** blob: URLs for a tab, shared with other tabs using the same bundle and settings. */
	frameUrls(bundle: Bundle, params: Record<string, string>): FrameUrls {
		const key = `${bundle.header.pdfcraftCommit}|${JSON.stringify(params)}`;
		let entry = this.frames.get(key);
		if (!entry) {
			entry = { urls: makeFrameUrls(bundle, params), users: 0 };
			this.frames.set(key, entry);
		}
		entry.users++;
		return entry.urls;
	}

	/** A tab is done with its URLs; the last one out revokes them. */
	releaseFrameUrls(urls: FrameUrls) {
		for (const [key, entry] of this.frames) {
			if (entry.urls !== urls) continue;
			entry.users--;
			if (entry.users <= 0) {
				revokeFrameUrls(entry.urls);
				this.frames.delete(key);
			}
			return;
		}
	}
}

class PdfCraftSettings extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: PdfCraftPlugin,
	) {
		super(app, plugin);
	}

	override display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Open PDFs in PdfCraft by default")
			.setDesc(
				"On this device only. PDFs open in PdfCraft instead of Obsidian's viewer; the book button on a PdfCraft tab switches back. Embeds in notes and PDF++ keep using Obsidian's viewer.",
			)
			.addToggle((t) => t.setValue(this.plugin.openByDefault).onChange((v) => (this.plugin.openByDefault = v)));

		new Setting(containerEl)
			.setName("Your name for comments")
			.setDesc("PdfCraft signs comments and markups with this name, unless you set one in PdfCraft itself.")
			.addText((t) =>
				t
					.setPlaceholder("Guest")
					.setValue(this.plugin.settings.author)
					.onChange(async (v) => {
						this.plugin.settings.author = v;
						await this.plugin.saveSettings();
					}),
			);

		const app = new Setting(containerEl).setName("PdfCraft app").setDesc("Checking…");
		void this.plugin.loader.isDownloaded().then((have) => {
			const size = AppLoader.downloadSizeMb ? ` (about ${AppLoader.downloadSizeMb} MB)` : "";
			app.setDesc(
				have
					? "Downloaded on this device (or synced from another one)."
					: `Not downloaded yet${size}. It downloads the first time you open a PDF in PdfCraft, or now.`,
			);
			if (have) {
				app.addButton((b) =>
					b.setButtonText("Remove from this device").onClick(async () => {
						await this.plugin.loader.remove();
						new Notice("PdfCraft: removed. It downloads again the next time you open a PDF in PdfCraft.");
						this.display();
					}),
				);
			} else {
				app.addButton((b) =>
					b
						.setButtonText("Download now")
						.setCta()
						.onClick(async () => {
							b.setDisabled(true).setButtonText("Downloading…");
							try {
								await this.plugin.loader.get();
								new Notice("PdfCraft: downloaded.");
							} catch (e) {
								new Notice(`PdfCraft: ${errorText(e)}`, 8000);
							}
							this.display();
						}),
				);
			}
		});
	}
}

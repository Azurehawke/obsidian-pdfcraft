# PdfCraft for Obsidian

Edit the PDFs in your vault with [PdfCraft](https://github.com/Azurehawke/pdfcraft) without leaving Obsidian. Obsidian's own PDF viewer (and PDF++) stay as they are; this plugin adds a way to switch a PDF tab to PdfCraft and back.

## Install (BRAT)

1. Install **BRAT** from Community plugins and turn it on.
2. BRAT → **Add beta plugin** → `Azurehawke/obsidian-pdfcraft`.
3. Turn on **PdfCraft** under Community plugins.

BRAT keeps the plugin up to date from this repo's releases.

## Use

- **Open in PdfCraft:** the pencil button at the top of a PDF tab, the **Open in PdfCraft** item in a PDF's file menu (file explorer, tab menu), or the command *Open current PDF in PdfCraft*.
- **Back to Obsidian's viewer:** the book button on a PdfCraft tab, or the command *Open current PDF in Obsidian's viewer*.
- **Save** (Ctrl/Cmd+S or PdfCraft's Save) writes the PDF back to the vault file. Unsaved changes show as **●** in the tab title.
- **Save As** (Ctrl/Cmd+Shift+S) asks for a name and saves a copy in the same folder.
- If the PDF changes on disk (Syncthing, another app), an open PdfCraft tab reloads it.

## Settings

- **Open PDFs in PdfCraft by default** — on *this device only* (it isn't synced), so you can have it on a desktop and off on a phone. Embeds in notes and PDF++ keep using Obsidian's viewer.
- **Your name for comments** — the author name on comments and markups, unless you set one in PdfCraft itself.
- **PdfCraft app** — download it now, or remove it from this device.

## The PdfCraft app download

PdfCraft itself (about 12 MB) downloads once, the first time you open a PDF in it, from this repo's release for the plugin version. It is checked against a SHA-256 fingerprint built into the plugin, and stored in the plugin's folder as `pdfcraft-<version>.bin`, so Syncthing or Obsidian Sync carries it to your other devices and they don't download it again. A plugin update with a new PdfCraft downloads the new one once.

## Limits

- Closing a PdfCraft tab with unsaved changes discards them (you'll see a notice). Save first.
- Embedded PDFs in notes (`![[file.pdf]]`) and PDF++ links still use Obsidian's viewer.
- PdfCraft runs as a web app in the tab, so very large PDFs use more memory than Obsidian's viewer.

## Build

```sh
npm install
# Build PdfCraft's web app (Azurehawke/pdfcraft, branch `obsidian`) with Trunk, then:
npm run pack -- path/to/pdfcraft/dist/web   # writes pdfcraft-web.bin(.gz)
npm run build                                 # main.js with the bundle's fingerprint
```

GitHub Actions does this on every push: `dev` publishes the `dev-trial` prerelease, and `main` publishes a release when `manifest.json` has a new version.

## Licence

MIT. PdfCraft is by storytold and contributors; see its repository for its licence.

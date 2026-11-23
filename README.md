# ArtStation Archiver

ArtStation Archiver saves your ArtStation Marketplace purchases to a folder on your PC. You can browse the archived library offline, open a product’s files in File Explorer and add packs of your own. The app runs on Windows 10 and 11 and has an English interface.

**Development preview · 0.1.28**

## Run on Windows

1. Download or clone the source and install Node.js LTS with npm.
2. Double-click **Setup ArtStation Archiver.bat** once. It installs the versions in `package-lock.json` and downloads the Electron runtime.
3. Double-click **Start ArtStation Archiver.bat** to open the app. Use this launcher for subsequent starts. It runs the installed Electron runtime directly, without installing anything.

## Archive your library

1. Click **Choose library location** and select a folder for your products. Each user chooses their own location and signs in with their own ArtStation account.
2. Sign in to ArtStation in the window that opens. The window closes automatically after sign-in. The app reads your purchases and collections, saves descriptions and images, and downloads missing files for the release selected by the site.
3. Follow the progress panel to see how many products have been indexed and how many files remain. Use **Pause** and **Resume synchronization** to control the queue. If you close the app, verified files are kept and an interrupted file starts again on the next run.
4. Click **Synchronize library** to check for new products and missing files. The app remembers one library location. **Settings → Library location → Change location** opens a new or existing archive. Files stay in their original folder when you switch.

The library shows the newest purchases first and preserves imported collections and hidden products. **View** shows the release, license and files. **View Details** opens the gallery, rating and description. Links to videos, the author and the invoice open online. The archive stores ratings and product information without review text.

## Organize your packs

- Drag a card onto a collection to add it. A pack can belong to several collections and uses a single copy of its files. Drag the grip on the left to reorder collections, or hover over a collection and click the pencil to rename or delete it.
- Click **Add pack** and enter a name to create a local pack. Files, cover, author, version, description and collections are optional. New packs appear in **All**.
- Click **Open pack folder** to add files or subfolders directly. While **View** is open, the file list refreshes about every three seconds. **Open folder** next to a file selects it in File Explorer.

## Check or retry a download

**Synchronize library** reuses saved descriptions and previews. A file record contains its relative path, size, modification time, SHA-256 hash and last verification time. A normal sync checks file size and modification time, and recalculates the hash if those values have changed or were missing from an older record. An existing file with unexpected contents is protected from automatic replacement.

**View → Re-sync** refreshes one product’s release, metadata and formatted description, checks file contents against their hashes and downloads missing files. Use it to refresh older plain-text descriptions or to check for a new release. If a card has no saved product address, the app scans the library to find it. Re-sync becomes available when the current operation finishes.

Click **products need attention** in the progress panel to filter the current view to packs with errors. Click it again to restore the list. **Skip error** next to **Open pack folder** acknowledges the current errors for that pack. The choice survives a restart. **Re-sync** retries a skipped error.

If a public product page returns HTTP 404 or 410, the app remembers that the page is unavailable and continues downloading accessible purchase files. Re-sync checks the page again. When upgrading from an older version, run a normal sync to revisit old description errors and refresh covers from the library grid.

If a pack still fails, restart the app, retry the pack and open **Settings → Open logs folder**. `diagnostics.log` contains the newest events, including the product, file, operation and error. Earlier events roll over into `diagnostics.1.log` and `diagnostics.2.log`, with about 3 MiB retained in total. Opening the logs folder also records outstanding errors from older archives. Logs are stored in the Windows app profile. The logger filters out download URLs and sign-in data.

## Where your data lives

```text
YourLibrary/
  library.json
  Product title--product-id/
    product.json
    media/
      image-id.jpg
    files/
      original-name.zip
```

`library.json` stores the catalog, collections, order and download states. Each `product.json` records that product’s details and release. The `media` folder holds the cover, author avatar and gallery. Purchased files are saved in their original format in `files`. Duplicate names receive a numbered suffix such as ` (2)` before the extension. A download in progress has a temporary `.part` extension. Existing archives retain their previously recorded paths.

The Windows app profile stores settings, logs and the app’s ArtStation session separately from the archive. A fresh checkout contains only the project. Running it under a Windows profile that has used the app before will reopen that profile’s saved settings.

**Settings → Wipe all data** shows the current archive path before asking for confirmation. Confirming stops downloads, permanently deletes the current catalog and its product folders with their contents, and clears the app’s settings, logs and sign-in. The next launch or setup screen prompts for a library location. Other libraries and unrelated files outside the product folders are preserved. Choose **Cancel** to exit the dialog.

## Development

The app uses Electron, JavaScript, HTML and CSS, with JSON manifests for storage. To run from a terminal:

```sh
npm ci
npm start
```

If your npm configuration requires approval for dependency install scripts, allow the official `electron` package to install its runtime. To check syntax, run the automated tests and build a portable Windows executable:

```sh
npm run check
npm test
npm run dist
```

The portable executable is written to `dist/` and runs without a separate Node.js installation. Full-library synchronization still benefits from manual testing on different accounts and machines. See the [development roadmap](docs/ROADMAP.md).

The repository uses a file-by-file publish list in `.gitignore`. When contributing a new source file, test or public document, add its path there and check the result with `git add --dry-run .`. Local archives, account settings, development notes, cached dependencies and build output stay on the contributor’s machine.

## License

ArtStation Archiver’s source code and documentation are available under the [MIT License](LICENSE). Archived purchases and third-party dependencies retain their respective licenses.

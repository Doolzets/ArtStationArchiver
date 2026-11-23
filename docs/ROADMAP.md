# Development roadmap

This roadmap records the original milestones and their acceptance checks. The current user guide covers the features available in the development preview. [Read the user guide](../README.md).

## 1. Project preparation

Review the library and product views, document the requirements and integration risks, and start a development log. The initial preparation and decisions about Windows support, language, library ordering, media and collections were completed in November 2026.

## 2. Verify sign-in and access to purchases

- Sign in through the app’s dedicated browser window.
- Inspect the complete list of purchases, dates, licenses, collections and releases.
- Retrieve a description and gallery, download a small purchased file, interrupt the download and retry.
- Confirm a reproducible sign-in flow and verify the downloaded file before settling on the authentication and packaging approach.

## 3. Archive the catalog

- Import accessible purchases using relative paths. Record descriptions, images, authors, licenses and the contents of the latest accessible release.
- Compare the imported records with the source catalog and report incomplete items.
- Save product pages and previews during indexing so they remain available locally if a listing disappears.

## 4. Download files

- Download all files for the purchased license and latest accessible release. Preserve the library’s newest-first display independently of download order.
- Use temporary files, verify completed downloads, retry failures and recover the queue after a restart without duplicating files.
- Check behavior during long downloads, low disk space and session expiry.

## 5. Browse the local library

- Provide a grid with search, filters, collections and drag-and-drop.
- Support the purchase dialog, local file and folder actions, and links to the author and invoice.
- Show the gallery, description and rating in a separate details window. External video can open online. Review text is outside the archive scope.
- Use English controls, preserve imported collections and hidden purchases, and make incomplete downloads visible offline.
- Compare the interface to the original library and product views.

## 6. Build and publish

- Verify moving an archive, browsing offline and recovering from an interruption.
- Test first launch and sign-in on a clean Windows profile without developer tools. Verify account isolation with separately authorized accounts and use synthetic catalogs for edge cases.
- Prepare a portable build, usage instructions and anonymized examples. Include the project’s [MIT License](../LICENSE) with distributions.
- Inspect the Git file list before publishing. The source release should contain only project files. Personal archives, browser profiles and authenticated page captures belong on the local machine.
- Publish the source when the maintainer is ready. Estimate bulk download times only when file sizes and network throughput are known.

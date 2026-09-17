# my-release-stats

A static GitHub Pages site showing release download statistics for a fixed set of my projects,
inspired by [Somsubhra/github-release-stats](https://github.com/Somsubhra/github-release-stats).

**Live page:** https://yorikv.github.io/my-release-stats/

For each project (newest repository first) it shows total downloads, latest-release downloads,
a per-platform split (Windows / macOS / Linux / other, inferred from asset file names),
downloads per release, and a table of every release and asset.

## How it works

Everything runs in the browser against the public GitHub REST API — there is no build step.
Unauthenticated requests are limited to 60 per hour per IP and one load uses roughly 13, so
results are cached in `localStorage` for 10 minutes. Use **Refresh** to force a reload.

## Changing the project list

Edit `OWNER` and `REPOS` at the top of `app.js`. Ordering is computed from each repository's
creation date, so the list order doesn't matter.

## Running locally

```sh
python3 -m http.server
```

Then open http://localhost:8000.

# CHANGES

_Generated 2026-07-03 (report-changes run stream — first plan in this repo)._

## ✅ 1. Updater re-homed to the JayeMcC fork

`src-tauri/tauri.conf.json`: update endpoints now point solely at
`github.com/JayeMcC/maiterm` releases (drops `updates.maiterm.dev` +
the Flexmark-Intl fallback) with the fork's minisign public key.

Git add: `git add src-tauri/tauri.conf.json`
Git commit: `git commit -m "chore(updater): re-home update feed + signing key to JayeMcC fork"`

## ✅ 2. Ignore-file upkeep

`.gitignore` ignores `/scripts/meridian` (linked-tools sync artefact);
new `.cursorignore` un-ignores the managed linked-tools symlinks so the
editor indexes them.

Git add: `git add .gitignore .cursorignore`
Git commit: `git commit -m "chore(ignore): meridian sync artefact + cursorignore for linked-tools"`

## ✅ 3. Setup docs + updater store follow-ups (appended)

`docs/forwood-setup.md` — install section rewritten around the release
download (build-from-source demoted to app development); updater store
touch-ups pairing with the re-homed feed.

Git add: `git add docs/forwood-setup.md src/lib/stores/updater.svelte.ts`
Git commit: `git commit -m "docs(setup): download-first install; updater store follow-up"`

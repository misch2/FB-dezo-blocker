# Changelog

## 0.1.9 - 2026-08-21

- Removed the hidden 200-profile limit; values such as 1000 are now accepted.
- Persisted mode, timing, and profile-limit settings across rerenders and Facebook tabs.
- Kept queues, run progress, and logs isolated to the current Facebook tab.
- Preserved saved settings when clearing a queue.
- Added regression coverage for scans above 200 profiles and settings persistence.
- Synchronized the version shown in the panel with the userscript version.

## 0.1.8 - 2026-08-21

- Verified the Tampermonkey automatic-update path with a version-only userscript release.
- Simplified installation instructions to use the raw userscript URL.

## 0.1.7 - 2026-08-21

- Added homepage, update, and download metadata for Tampermonkey automatic updates.
- Documented automatic installation and update behavior.

## 0.1.6 - 2026-08-21

- Moved queues, run progress, and logs to per-tab session storage so jobs do not leak into other Facebook tabs.
- Added storage error handling and tab-isolation smoke coverage.
- Updated repository and author metadata and removed the prototype suffix from the script name.

## 0.1.5 - 2026-08-18

- Fixed recognition of Facebook confirmation controls that expose the same label as both visible text and an accessibility label.
- Added the version number to the panel header.

## 0.1.4 - 2026-08-18

- Added support for Facebook's generic Confirm confirmation control.
- Restricted confirmation handling to a blocking dialog that matches the current profile.
- Rejected unrelated confirmation dialogs and mismatched profile names.

## 0.1.3 - 2026-08-18

- Added reaction icons to the scanned profile preview.
- Blocked guided and automatic runs when a scanned profile is missing its reaction icon.
- Restricted reaction icon URLs to trusted Facebook content hosts.
- Added smoke coverage for icon extraction, rendering, and URL validation.

## 0.1.2 - 2026-08-18

- Replaced generic dialog selection with conservative reaction-dialog scoring.
- Displayed the detected selected reaction in the panel summary.
- Selected the deepest matching reaction dialog to avoid collecting profiles from the surrounding post dialog.
- Added smoke coverage for dialog selection, profile filtering, deduplication, and dry-run behavior.

## 0.1.1 - 2026-08-18

- Added the initial Tampermonkey userscript and control panel.
- Added scanning, filtering, and deduplication of profiles from an opened reaction dialog.
- Added dry-run, guided, and automatic modes with randomized delays and a configurable run limit.
- Added queue persistence across profile navigation, progress logging, and pause, continue, skip, stop, return, and clear controls.

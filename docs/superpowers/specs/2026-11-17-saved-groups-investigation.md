# Saved Chrome tab groups — investigation

Issue: #10
Date: 2026-11-17
Status: research only; no implementation

## Summary

The issue's premise is false on Chrome 157 for Windows: saved tab groups are
not stored in the profile's `Bookmarks` file. They live in the profile's
`Sync Data/LevelDB` store as `saved_tab_group-*` entities. The group and tab
specifics are plaintext protobufs, so a read-only lister is technically
feasible, but it requires an internal LevelDB reader. Deletion is not
reliably possible by editing local state; Chrome Sync can restore the entity.
A real delete requires Chrome's sync protocol and the account's OAuth
credentials. The supported per-group delete is Chrome's own UI, and the
Google Account side only offers a blanket sync reset.

No credentials were extracted, no sync data was written, and no Chrome state
was modified during this investigation.

## Evidence

- Closing the `xxyz` group did not change `Bookmarks`; its mtime stayed at
  2026-11-15 and no folder carried `tab_group_*` metadata.
- `Default/Sync Data/LevelDB/002159.log` contains 121 `saved_tab_group`
  markers and the `xxyz` group name.
- The store has `saved_tab_group-dt-<uuid>` (entity data) and
  `saved_tab_group-md-<uuid>` (metadata) keys.
- Decoding a `-dt-` `EntityData` value yields the saved-group specifics:
  - wrapper field 2 = `SavedTabGroupSpecifics`
  - specifics: field 1 guid, field 2 creation time, field 3 update time,
    field 4 `SavedTabGroup`, field 5 `SavedTabGroupTab` (oneof)
  - group: field 2 title, field 3 position, field 4 color
  - tab: field 1 `group_guid`, field 2 position, field 3 URL, field 4 title
- Group and tab entities are linked by `group_guid`; tab URLs were plaintext
  in this profile.
- The `-md-` values are opaque base64/entity metadata. They are not a public
  delete handle.
- The `SavedTabGroupSpecifics` proto defines `SavedTabGroup`
  (position/title/color) and `SavedTabGroupTab`
  (group_guid/position/url/title); tabs are separate entities because of
  sync entity size limits.

## Feasibility

### Read-only listing

Technically feasible:

1. Read the `Sync Data/LevelDB` store.
2. Decode `EntityData` and the `SavedTabGroupSpecifics` protobuf.
3. Join tab entities to group entities by `group_guid`.
4. Return group title/color and tab title/URL.

Costs and risks:

- Requires a LevelDB implementation: a new native dependency (for example
  `classic-level`) or an in-tree WAL/SSTable parser.
- Chrome holds the LevelDB `LOCK` while running; the reader needs a
  read-only/locked-store strategy or a safe copy.
- The schema and store layout are internal and can change between Chrome
  versions.
- macOS TCC/MACL applies to the same profile directory.
- No supported API; the result is best-effort and version-fragile.

### Deletion

Not reliable through local state:

- Deleting the local `saved_tab_group-*` rows does not create a sync
  tombstone.
- Chrome Sync can re-download the entity on the next sync, or another device
  can re-upload it.
- A proper delete needs a sync commit (tombstone) with the account's OAuth
  token, client state (`store_birthday`, client ID), and server entity ID.
- The OAuth token is in Chrome's encrypted credential/cookie store, not the
  sync LevelDB. Extracting it is account-level credential access, far beyond
  this tool's scope.
- The sync protocol is internal and can change without notice; a malformed
  commit can corrupt sync state or delete more than intended.

### Online / account-side delete

No per-group web UI or public API was found. The Google Account / Chrome
sync data page offers a blanket `Delete data` / `Reset sync` (all synced
data), not individual saved groups. Deleting a synced group in Chrome's UI
is the supported per-group path and propagates the deletion to other
devices.

## Recommendation

- Do not implement Sync Data writes or a sync-protocol delete.
- A read-only lister is a possible follow-up only if the internal LevelDB
  dependency and fragility are accepted; it would not provide deletion.
- Use Chrome's UI to delete saved groups. The account-side alternative is a
  blanket sync reset, which deletes all synced data and is not a targeted
  cleanup.
- Pause #10 unless Chrome exposes a supported saved-group API or the
  read-only lister is explicitly wanted despite the cost.

## Sources

- Google tab-group sync announcement:
  https://blog.google/products-and-platforms/products/chrome/google-chrome-update-september-2024/
- `SavedTabGroupSpecifics` proto fields:
  https://sources.debian.org/src/chromium/117.0.5938.149-1~deb12u1/components/sync/protocol/saved_tab_group_specifics.proto/
- Chrome sync data deletion (blanket reset) walkthrough:
  https://www.easytechguides.com/delete-web-browser-sync-data/
- Tab-group delete/close sync behavior summary:
  https://windowsforum.com/news/enable-vertical-tabs-in-chrome-without-experimental-flags.445301/

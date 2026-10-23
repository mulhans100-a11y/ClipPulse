# Medal capture support

## What the editor supports today

ClipPulse imports files and recursively scans a user-selected local folder. It retains source paths, records metadata, detects identical content, and does not modify or upload captures. This works for Medal captures that exist as local files, as well as OBS, ShadowPlay, ReLive, and other supported media formats.

There is no Medal account login, private-cloud download, or web scraping in this build.

## Capture-folder shortcut

The Medal button in the media panel checks `<system drive>:\Medal`, matching Medal's documented Windows default (their support article gives `C:\Medal` as an example). If that folder is missing, ClipPulse opens a folder picker so the user can select a custom location configured in Medal. On other platforms, the user selects the local capture folder directly.

The selected folder is recursively imported and registered with ClipPulse's existing recursive watcher. New supported media files are then indexed and added when the watcher detects changes. ClipPulse does not read Medal's private database or modify the capture files.

Source: [Medal Support — Managing PC Storage](https://support.medal.tv/support/solutions/articles/48001275457/)

## Public API findings

Medal's official API terms describe displaying selected user-generated content that users have shared publicly on Medal through a third-party service. The official Medal developer portal documentation we found is for game developers who create auto-clipping events and trigger Medal's desktop app to save a local player's gameplay around those events. This does not document an account API for browsing and downloading that user's private cloud library.

Medal's official help article about web access says the website can show general feed and published clips, but does not provide access to unlisted, cloud-synced, or expiring clips. The app therefore does not treat public post endpoints, undocumented endpoints, browser session tokens, or third-party downloaders as an authorized route to personal cloud captures.

If Medal later documents an account-authorized user library API with terms that permit a local editor to import and process the content, that integration can be evaluated separately. Until then, use Medal's own app to make a local copy and import that folder.

## Sources checked (22 October 2026)

- [Medal API terms](https://medal.tv/terms), section 5, describes API display of content shared publicly by users.
- [Medal Developer Docs: Auto clipping quickstart](https://medal.tv/portal/docs/auto-clipping), which documents a game developer workflow for creating events and keys.
- [Medal support: platform support](https://medaltv.freshdesk.com/support/solutions/articles/48001271455-platform-support-on-medal-tv), which describes the limitations of Medal's web experience for private/unlisted/cloud-synced content.
- [Medal support: managing clips](https://medaltv.freshdesk.com/support/solutions/articles/48001164598-how-to-manage-clips-on-medal), which documents local/cloud filtering and app-side clip management.

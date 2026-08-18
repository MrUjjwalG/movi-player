# Privacy Policy

**Last updated:** August 18, 2026

**Movi Player — Web Player, Chrome Extension & Google Drive integration**

Movi Player is an open-source video player. Your privacy matters to us, and Movi Player is designed so that your video files stay on your device.

## What We Do Not Do

- **No analytics or tracking** — We use no analytics services, tracking pixels, or telemetry.
- **No user accounts** — Movi Player requires no sign-up or authentication.
- **No cookies** — We set and read no cookies.
- **No advertising** — We run no ads and share no data with advertisers or data brokers.
- **We never see your video** — No file you play is uploaded to us, stored by us, or inspected by us.

## Video Playback

**Local files.** A file you drag in or pick from your device is read entirely in your browser. It is never uploaded anywhere.

**Google Drive files.** These stream directly from Google's servers to your browser.

**URLs you paste.** Movi Player normally fetches the video straight from the host you named — the request goes from your browser to that host, and we are not involved.

Some hosts do not send the cross-origin headers a browser requires for playback. In that case only, the request is routed through a fetch relay we operate so the bytes can reach your player. When that happens:

- The relay **streams bytes through and stores nothing** — no caching, no recording, no copy retained.
- We do not log the URLs you play, and we do not build any profile of what you watch.
- Your IP address is visible to Cloudflare, which serves this site, as it is for any website you visit.
- **Embedded players (`/embed`) never use the relay** — they always load from the source host directly.

## Visitor Comments

If you post in the feedback section on moviplayer.com, we store what you submit: the display name you type, your comment text, an optional rating, and a timestamp. Comments are public.

We also store a **salted, truncated one-way hash of your IP address** solely to rate-limit spam. The hash cannot be reversed to recover your IP, and your actual IP address is never written to our database.

Comments are stored in Cloudflare D1. To have a comment you posted removed, email the address at the bottom of this page.

## Local Storage

Movi Player stores your playback preferences (such as volume level and resume position) in your browser's local storage. This data stays on your device and is never transmitted to us.

## Chrome Extension Permissions

| Permission | Purpose |
|---|---|
| `contextMenus` | To add a "Play with Movi Player" option when you right-click a video link |
| `activeTab` | To detect video URLs on the current page |
| `clipboardRead` | To allow pasting video URLs directly into the player |

These permissions are used solely for their stated purpose and grant no access to browsing history, personal data, or any other information.

## Third-Party Services

- **Cloudflare** hosts and serves moviplayer.com. Cloudflare processes connection data (including IP addresses) as part of delivering the site.
- **Cloudflare Turnstile** protects the comments form from bots. It is used in place of a tracking-based CAPTCHA.
- **Google Drive**, if you choose to use that integration, is subject to [Google's Privacy Policy](https://policies.google.com/privacy). Movi Player's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

We share data with no one else.

## Your Rights

You may request deletion of any comment you have posted, or ask what data associated with you we hold, by writing to the contact address below. Because we operate no accounts and store no viewing history, in most cases the answer is that we hold nothing about you at all.

## Open Source

Movi Player is open source. You can review the entire source code — including the relay and comments code described above — at [github.com/MrUjjwalG/movi-player](https://github.com/MrUjjwalG/movi-player).

## Changes to This Policy

If we make changes to this privacy policy, we will update the "Last updated" date above.

## Contact

Privacy questions or deletion requests: **privacy@moviplayer.com**, or open an issue on our [GitHub repository](https://github.com/MrUjjwalG/movi-player/issues).

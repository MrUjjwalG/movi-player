# Terms of Service

**Last updated:** August 18, 2026

**Movi Player — Web Player, Chrome Extension & Google Drive integration**

These Terms of Service ("Terms") govern your use of Movi Player, an open-source video player that runs in your web browser. By using Movi Player — including the website at [moviplayer.com](https://moviplayer.com), the Chrome extension, or the "Open with Movi Player" Google Drive integration — you agree to these Terms. If you do not agree, please do not use the service.

## Description of Service

Movi Player is a client-side video player powered by WebCodecs and FFmpeg WebAssembly. All video decoding and playback happen locally in your browser.

**We do not host, store, index, or provide any video content.** Movi Player ships with no library, no catalogue, and no search over third-party media. Every video played is one you supply — a file on your device, a file in your own Google Drive, or a URL you paste.

**How your video reaches the player:**

- **Local files** (drag-and-drop or file picker) are read entirely on your device. They are never uploaded, and never touch any server we operate.
- **Google Drive files** stream directly from Google's servers to your browser.
- **URLs you paste** are normally fetched by your browser directly from the host you named. Where that host does not permit cross-origin playback, the request may pass through a fetch relay we operate purely to satisfy browser CORS rules. That relay is a transient conduit: it does not store, cache, transcode, index, or retain the media, and it only forwards bytes that you specifically requested. Embedded players (`/embed`) never use the relay at all.

## Acceptable Use

You are responsible for the content you choose to play with Movi Player. You agree to use the service only with content that you own, or are otherwise legally permitted to access and play, and only in compliance with all applicable laws.

You may not use Movi Player to access, reproduce, distribute, publicly perform, or circumvent access controls on content in violation of any third party's rights, and you may not use it for any content that is unlawful in your jurisdiction.

We do not monitor, and have no practical ability to monitor, what any visitor plays — decoding happens on the visitor's own device. Responsibility for the legality of a chosen source rests with the person who chose it.

## Reporting Infringing or Unlawful Content

We take rights-holder and abuse reports seriously and act on valid notices.

Because we host no content, the usual remedy is to have the material removed at its actual source. Where a URL is reaching a visitor's browser through our fetch relay, we can and will block that URL or host on request from a rights holder or their authorised agent.

To submit a notice, email **abuse@moviplayer.com** with:

1. Identification of the copyrighted work or other right you claim is infringed.
2. The specific URL(s) at issue.
3. Your contact details (name, address, telephone, email).
4. A statement that you have a good-faith belief the use is not authorised by the rights holder, its agent, or the law.
5. A statement, under penalty of perjury, that the information in the notice is accurate and that you are the rights holder or authorised to act on their behalf.
6. Your physical or electronic signature.

We aim to acknowledge notices within 48 hours. If you believe a URL was blocked in error, you may send a counter-notice to the same address.

**Repeat infringers.** Hosts and URLs that are the subject of repeated valid notices are blocked permanently at the relay.

## Grievance Officer (India)

In accordance with the Information Technology Act, 2000 and the Information Technology (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021:

- **Grievance Officer:** Ujjwal Kashyap
- **Email:** grievance@moviplayer.com

Complaints are acknowledged within 24 hours and resolved within 15 days of receipt. Content will be removed or access disabled within 36 hours of receiving an order from a court of competent jurisdiction or an appropriate government agency.

## Visitor Comments

The feedback section on moviplayer.com accepts public comments. You are responsible for what you post. Do not post unlawful, defamatory, abusive, or infringing material, spam, or another person's private information. We may remove any comment at our discretion, and we remove unlawful comments on notice via the contact addresses above.

## Google Drive Integration

Movi Player offers an optional integration that lets you play video files stored in your own Google Drive.

- Access is **read-only**. Movi Player never edits, deletes, moves, shares, renames, or uploads any file in your Drive.
- When you open a video, Movi Player streams the file's bytes directly from Google's servers to your browser (using ranged HTTP requests) and decodes them locally for playback.
- File contents are **never sent to, stored on, or logged by any server operated by us**, and are never shared with any third party.
- You may revoke Movi Player's access to your Google account at any time via [Google Account permissions](https://myaccount.google.com/permissions).

Movi Player's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Open Source & License

Movi Player is open-source software released under the Apache-2.0 License. You may review, use, and modify the source code at [github.com/MrUjjwalG/movi-player](https://github.com/MrUjjwalG/movi-player) in accordance with that license.

## Disclaimer of Warranties

Movi Player is provided **"as is" and "as available"**, without warranties of any kind, whether express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, and non-infringement. We do not warrant that the service will be uninterrupted, error-free, or compatible with every file, codec, browser, or device.

## Limitation of Liability

To the maximum extent permitted by law, in no event shall the developers or contributors of Movi Player be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of data, arising out of or related to your use of — or inability to use — the service.

## Third-Party Services

The Google Drive integration relies on Google APIs and is subject to [Google's Terms of Service](https://policies.google.com/terms) and the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy). The site is served through Cloudflare, and the comments form is protected by Cloudflare Turnstile. Your use of any content you play remains subject to the terms of the source from which it originates.

## Privacy

Your use of Movi Player is also governed by our [Privacy Policy](/privacy-policy), which explains what data is (and is not) collected.

## Changes to These Terms

We may update these Terms from time to time. When we do, we will revise the "Last updated" date above. Continued use of Movi Player after changes take effect constitutes acceptance of the revised Terms.

## Contact

- **Abuse and copyright notices:** abuse@moviplayer.com
- **Grievances (India):** grievance@moviplayer.com
- **Everything else:** open an issue on our [GitHub repository](https://github.com/MrUjjwalG/movi-player/issues)

# BitChord FLAC Aggregator 🎧

**A Cloudflare Workers music-source aggregator focused on FLAC playback, fast recovery, and optional free-access music catalogs.**

> **Version:** 3.7.0 (Free Sources Edition)  
> **Platform:** Cloudflare Workers (JavaScript)  
> **Client:** Designed for the BitChord music app's addon API  
> **Status:** Community project / unofficial integration

BitChord FLAC Aggregator collects track-search results from compatible music addons, attempts to resolve lossless streams, and looks for the same recording from another configured source if the first one fails. It also supports optional Jamendo integration, Internet Archive FLAC files, and a personal FLAC library hosted on Cloudflare R2.

**The goal is simple:** prefer a real, playable FLAC source over an unreliable or mislabeled audio link, without silently substituting MP3, AAC, or Opus.

## Contents

- [Why this project exists](#why-this-project-exists)
- [Features](#features)
- [How it works](#how-it-works)
- [Sources and costs](#sources-and-costs)
- [Deployment](#deployment)
- [Optional: Jamendo](#optional-jamendo)
- [Optional: Personal FLAC library with R2](#optional-personal-flac-library-with-r2)
- [Usage and API routes](#usage-and-api-routes)
- [Troubleshooting](#troubleshooting)
- [Development history](#development-history)
- [Security, copyright, and limitations](#security-copyright-and-limitations)

## Why this project exists

The project began as a single Cloudflare Worker to combine several BitChord-compatible music addon sources. Real-world playback showed several recurring problems:

- Some songs appeared in search results but skipped immediately when FLAC was requested.
- Upstream providers intermittently returned `404`, `429`, or `502`, or exceeded request timeouts.
- FLAC quality upgrades could take too long or become stuck.
- An unavailable lossless source could lead the client to use a separate, lossy playback source.
- Some providers advertised lossless quality without returning a usable FLAC stream.

The Worker was improved through repeated testing and analysis of Cloudflare Worker logs. Each release focused on reliability, bounded response times, better diagnostics, and protecting the lossless-only preference.

## Features

| Feature | What it does |
| --- | --- |
| **Lossless-focused playback** | Refuses known MP3, AAC, Opus, WebM, and other non-FLAC stream formats. |
| **Multiple upstream addons** | Searches user-configured BitChord-compatible providers without changing their index positions. |
| **Cross-provider FLAC rescue** | Tries alternative matches when an upstream FLAC resolver fails. |
| **Recording matching** | Compares song title, artist, and available duration to reduce incorrect version/remix matches. |
| **Faster quality upgrades** | Uses bounded timeouts, a rescue deadline, and a small set of parallel alternatives. |
| **Provider cooldowns** | Temporarily deprioritizes some sources after errors or rate limiting. |
| **Jamendo integration** | Optional track search and FLAC resolution with your own API client ID. |
| **Internet Archive integration** | Searches for actual matching `.flac` files within archives. |
| **Personal R2 library** | Optionally streams your own authorized FLAC files with HTTP Range support. |
| **Diagnostic logs** | Records upstream failure classes, search results, and FLAC rescue outcomes. |
| **Legacy track ID support** | Existing IDs can still resolve through their original source; new searches add metadata for rescue. |

**Important:** For Jamendo, Internet Archive, and the optional R2 library, the Worker checks the beginning of the audio file for the FLAC `fLaC` signature. For other third-party addons, it relies on stream metadata and URL clues, so it cannot guarantee the actual codec without inspecting the upstream audio bytes.

## How it works

```text
BitChord app
    |
    +-- GET /manifest.json          -> addon metadata
    |
    +-- GET /search?q=...           -> search configured lossless sources
    |                                   -> rank matching tracks
    |                                   -> embed safe matching metadata in IDs
    |
    +-- GET /stream/{source}:{id}   -> request FLAC from primary source
                                          |
                                          +-- FLAC candidate accepted -> return stream JSON
                                          |
                                          +-- failed -> try known matching sources
                                                       -> short additional search if time permits
                                                       -> return FLAC or an error
```

The Worker normally **returns JSON containing a stream URL**. The music app then fetches the audio from that URL. The optional R2 route is different: it serves the personal audio bytes directly.

Cross-provider recovery is best with **fresh search results**, because these include matching metadata. Old bookmarked IDs may still resolve through their original provider without full recovery information.

## Sources and costs

| Source | Included in v3.7? | Access requirements | Notes |
| --- | --- | --- | --- |
| Compatible third-party addons | Yes | **Your own authorized addon URLs**, where applicable | Reliability, access rules, and quality vary by provider. |
| Internet Archive | Yes, enabled by default | No account for public files | Availability depends on archives and their usage rights. |
| Jamendo | Yes, optional | Your own developer client ID | Subject to Jamendo API terms, permissions, and rate limits. |
| Cloudflare R2 personal files | Yes, optional | R2 bucket and legally usable FLAC files | Free allowances exist; charges may apply above them. |
| JioSaavn / Piped | Legacy helper code only | Not enabled for FLAC-only results | These are not used as lossy fallbacks in strict FLAC mode. |

**“Free sources” does not mean unlimited access or unlimited Cloudflare usage.** Check each provider's policies. A free API or public archive does not confer the right to redistribute copyrighted recordings.

## Deployment

### Prerequisites

- A Cloudflare account with access to **Workers & Pages**.
- The v3.7 Worker JavaScript file (`bit_chord_flac_free_sources_v3_7.js`) from your **private, trusted copy** of the project.
- Any upstream addon addresses you are authorized to use.
- Optionally, a Jamendo client ID or R2 bucket.

### 1. Prepare the Worker safely

Open the JavaScript file and locate `DISCORD_ADDONS` near the top. **Do not commit signed URLs, subscription links, private paths, or API tokens to a public repository.** If you publish a code example, replace private entries with placeholders:

```js
const DISCORD_ADDONS = [
  "https://your-authorized-addon.example"
  // Add only sources you are allowed to use.
];
```

The supplied project preserves upstream entries by array index (`discord_0`, `discord_1`, etc.). **Keep their order stable after deployment**, because saved track IDs refer to those indexes. Removing or reordering entries can break saved tracks.

**Public-repository warning:** Previous private Worker builds contain upstream addresses that appear to embed access tokens. Do not upload those builds as-is. Rotate any credentials that have already been exposed publicly.

### 2. Create or update a Cloudflare Worker

1. Open [Cloudflare Dashboard](https://dash.cloudflare.com/) and select **Workers & Pages**.
2. Create a Worker, or select an existing Worker you want to update.
3. Open **Edit Code**.
4. Paste your prepared v3.7 JavaScript code into the Worker editor.
5. Click **Deploy**.
6. Visit `https://YOUR-WORKER.workers.dev/manifest.json` to check that the manifest is returned as JSON.

You can deploy the basic aggregator without Jamendo or R2. The optional integrations remain disabled when not configured.

### 3. Add it to BitChord

Use the manifest URL for your deployed Worker:

```text
https://YOUR-WORKER.workers.dev/manifest.json
```

Add this URL using the addon-management interface supported by your version of BitChord, then search for a track. Re-searching songs generates the newer metadata-bearing IDs used for cross-provider recovery.

### 4. Check the logs

Go to **Workers & Pages → your Worker → Observability / Logs**, then attempt a track that previously failed. The exact dashboard labels may differ by Cloudflare UI version.

## Optional: Jamendo

Jamendo's track API supports requesting `audioformat=flac`. You need a developer client ID from **your own application**. Use is subject to its terms and available access level.

1. Sign up through the [Jamendo developer portal](https://devportal.jamendo.com/).
2. Create an application and obtain its `client_id`.
3. Open your Worker in Cloudflare, then **Settings → Variables and Secrets → Add**.
4. Choose **Secret**, set its name to `JAMENDO_CLIENT_ID`, and enter your client ID as the value.
5. Save/deploy the new setting.
6. Search for available Jamendo music in BitChord.

```text
Variable name: JAMENDO_CLIENT_ID
Type: Secret (recommended)
Value: <your own Jamendo client ID>
```

The Worker reads this value through `env.JAMENDO_CLIENT_ID`. No code edit is needed. Keep in mind that a secret binding hides its value from normal dashboard viewing; it does **not** prevent the Worker from including the client ID in requests to Jamendo's API.

Documentation: [Jamendo tracks API](https://developer.jamendo.com/v3.0/tracks) · [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## Optional: Personal FLAC library with R2

This feature is **not required** for the public-source integrations.

1. In Cloudflare, create an **R2 Standard** bucket and upload FLAC files you own or have permission to stream.
2. In the Worker, add an **R2 bucket binding** named `FLAC_BUCKET` that points to your bucket.
3. Edit the `PERSONAL_FLAC_TRACKS` array in your Worker code:

```js
const PERSONAL_FLAC_TRACKS = [
  {
    key: "MyMusic/Artist - Song.flac",
    title: "Song",
    artist: "Artist",
    duration: 240
  }
];
```

4. Make sure each `key` matches the R2 object key exactly.
5. Deploy and search for your track in BitChord.

The Worker reads the first four bytes to identify FLAC and supports HTTP Range requests at URLs like:

```text
https://YOUR-WORKER.workers.dev/audio/personal/0.flac
```

**Security warning:** This audio endpoint is public in the current implementation. Do not put private, confidential, or redistributable-without-permission material here. It does **not** require a login. R2 has a Standard storage free tier, but usage beyond the included allowance can incur charges; consult [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## Usage and API routes

| Method | Route | Response |
| --- | --- | --- |
| `GET` | `/manifest.json` | BitChord addon manifest JSON |
| `GET` | `/search?q=artist+title` | JSON object with a `tracks` array |
| `GET` | `/stream/{provider}:{trackId}?quality=LOSSLESS` | Stream metadata JSON, or an HTTP error when no accepted FLAC is found |
| `GET` | `/audio/personal/{index}.flac` | Audio bytes from configured R2 library, including supported Range requests |

Example search:

```text
https://YOUR-WORKER.workers.dev/search?q=artist%20song&quality=LOSSLESS
```

`/search` can list tracks claimed to be lossless. Actual stream resolution is performed on `/stream`; a search result is **not** a guarantee of successful playback.

## Troubleshooting

| Symptom / log message | Likely meaning | Suggested action |
| --- | --- | --- |
| `[UPSTREAM HTTP] ... status=404` | Provider cannot find that endpoint or track | Try a different authorized provider; confirm its route. |
| `[UPSTREAM HTTP] ... status=429` | Provider rate limit | Reduce repeated requests; allow its cooldown to expire. |
| `[UPSTREAM HTTP] ... status=502` | Provider-side gateway error | Retry later or inspect that upstream service. |
| `[UPSTREAM TIMEOUT]` | Upstream did not respond within the deadline | Check provider health and latency. |
| `[NO FLAC]` | No stream met the Worker's FLAC acceptance rules | Re-search in BitChord; verify that another provider has the recording. |
| `[FLAC RESCUE SUCCESS]` | Another matched source supplied an accepted FLAC response | Check playback in BitChord to confirm the audio actually works. |
| `[FLAC RESCUE EXHAUSTED]` | Recovery candidates failed or the deadline was reached | Check available sources and whether the exact recording is offered. |
| BitChord still plays Opus | BitChord may have selected **another installed source** | Review app-level source priority and lossy fallback settings. |
| Jamendo tracks absent | Missing client ID, API permissions, or no matching tracks | Confirm `JAMENDO_CLIENT_ID` and provider availability. |
| R2 track absent | Bucket not bound or track not listed | Check `FLAC_BUCKET`, `PERSONAL_FLAC_TRACKS`, and object key. |

Logs can contain request URLs, track IDs, and other sensitive metadata. **Redact tokens, authorization headers, account identifiers, and private stream URLs before sharing them.**

## Development history

The project evolved through several iterations informed by Cloudflare log samples and local mocked tests:

| Release | Focus |
| --- | --- |
| **v3.4.x** | Initial aggregator reliability, upstream error logs, and timeout handling. |
| **v3.5.0** | Cross-provider song matching and FLAC rescue. |
| **v3.6.0** | Faster resolution and stricter rejection of known lossy streams. |
| **v3.6.1** | Preferred-source ordering, provider cooldowns, and additional recovery search. |
| **v3.7.0** | Optional Jamendo, improved Internet Archive matching, and optional personal R2 playback. |

The main development workflow was **reproduce a playback failure → inspect Worker logs → patch the source-selection or resolution logic → run local simulated tests → deploy and test in BitChord**. Local tests do not replace live playback tests, and external providers can change without notice.

## Security, copyright, and limitations

- **Not affiliated with** BitChord, Cloudflare, Jamendo, Internet Archive, or third-party addon maintainers.
- **No DRM bypass:** This project is not intended to circumvent subscriptions, access controls, copyright, or provider terms.
- **Use only authorized sources:** Never publish someone else's signed stream URLs, credentials, or protected endpoints.
- **FLAC only within this Worker:** It rejects known lossy streams, but the BitChord app can independently choose other installed providers.
- **No guaranteed catalog availability:** A source can be down, rate limited, geographically restricted, or missing an exact recording.
- **No guaranteed codec for arbitrary third-party URLs:** Some sources are validated from metadata only; a label is not a bitstream proof.
- **Public R2 playback:** Files exposed through `/audio/personal/` are publicly reachable in this version.
- **Costs:** The Worker and optional services may be subject to Cloudflare free-plan usage limits and other provider-specific quotas or fees.
- **No license specified:** Do not assume a particular open-source license or redistribution permission merely because a repository is public. Add a `LICENSE` file if you decide to grant reuse rights.

## Useful documentation

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Jamendo tracks API](https://developer.jamendo.com/v3.0/tracks)
- [Jamendo developer portal](https://devportal.jamendo.com/)
- [Internet Archive API](https://archive.org/developers/)

---

**Built for smoother lossless listening, with respect for source access rules and artists' rights.**

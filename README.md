# BitChord FLAC Aggregator 🎧

**A lossless-focused music-source aggregator for BitChord, powered by Cloudflare Workers, with optional public FLAC catalogs and a private 36-hour R2 cache.**

> **Latest release:** `v3.7.5` · **36-Hour R2 Cache Edition**  
> **Runtime:** JavaScript on Cloudflare Workers  
> **Client:** BitChord-compatible addon API  
> **Project status:** Unofficial, personal/community integration; not affiliated with BitChord or the listed providers

BitChord FLAC Aggregator searches compatible sources for music, prefers FLAC streams, and attempts to recover the **same recording** from another provider if the first one fails. Version **3.7.5** adds an **opt-in, private Cloudflare R2 cache**: play an existing cached FLAC when available, or use the normal providers and, **only when copying is permitted**, save an actual FLAC file for reuse over the next **36 hours**.

**Design priorities:** real FLAC over misleading quality labels; avoid unwanted lossy substitutes *within this addon*; preserve fast searches and existing source IDs; keep caching optional, private, bounded, and permission-aware.

> [!IMPORTANT]
> This Worker cannot prevent the **BitChord app itself** from independently falling back to a different addon or YouTube/Opus. It rejects known lossy streams returned through **this Worker**. Also, `LOSSLESS` in a search result is a claim, **not proof** that the recording can be played as FLAC.

## Contents

- [What's new in v3.7.5](#whats-new-in-v375)
- [Features](#features)
- [Architecture and playback flow](#architecture-and-playback-flow)
- [Supported sources](#supported-sources)
- [Deployment](#deployment)
- [36-hour private FLAC cache: Cloudflare R2](#36-hour-private-flac-cache-cloudflare-r2)
- [Other optional integrations](#other-optional-integrations)
- [API routes](#api-routes)
- [Live monitoring and testing](#live-monitoring-and-testing)
- [Troubleshooting](#troubleshooting)
- [Costs, security, and copyright](#costs-security-and-copyright)
- [Release history](#release-history)
- [Documentation](#documentation)

## What's new in v3.7.5

**v3.7.5 builds on v3.7.4 and preserves previous search, rescue, and recording-matching behavior.**

| Addition | Behavior |
| --- | --- |
| **Read-through R2 cache** | Checks a private R2 bucket for a matching, nonexpired recording before resolving an upstream stream. |
| **36-hour expiration** | The Worker stops serving cached objects after 36 hours. An hourly Cron Trigger deletes expired objects. |
| **Nonblocking cache write** | First playback uses the original resolved URL immediately; a permitted FLAC copy is attempted via `ctx.waitUntil()`. Writes are best-effort. |
| **FLAC byte verification** | Checks the first four downloaded bytes for the real FLAC `fLaC` signature before storing. |
| **Signed cache playback** | Temporary HMAC-signed `/audio/cache/` links; supports `GET`, `HEAD`, and byte-range requests. |
| **Storage safeguards** | Maximum 100 MiB per cached file; 2 GiB target for total cache; refuse unknown-size downloads. |
| **Permission allowlist** | Caches **only** resolved providers explicitly listed in `FLAC_CACHE_ALLOWED_PROVIDERS`. |
| **Cache discovery** | Previously saved recordings can appear in search results even if the upstream provider is temporarily unavailable. |

**Retained from recent releases:**

- **v3.7.4:** Optional **Openverse** and **Wikimedia Commons** FLAC discovery via their public APIs.
- **v3.7.3:** Smarter title/artist/duration matching, including distinguishing original mixes, album edits, mixed cuts, and remixes.
- **v3.7.2:** Improved soundtrack/game-music matching and diagnostic logging.
- **v3.7.1:** Responsive staged searches and improved upstream selection.

> [!NOTE]
> **No persistent song database is needed for the cache.** FLAC bytes and limited searchable metadata live in R2 objects. A separate D1 database or Navidrome server is **not required**.

## Features

| Feature | Description |
| --- | --- |
| FLAC-focused responses | Rejects known MP3, AAC, Opus, WebM, and other non-FLAC candidates within this addon. |
| Multiple source addons | Searches configured BitChord-compatible upstreams with stable provider IDs (`discord_0`, `discord_1`, etc.). |
| Cross-provider rescue | Attempts an equivalent recording from alternative providers when FLAC resolution fails. |
| Recording-aware matching | Compares title, artist, version/mix wording, and available duration to avoid wrong edits and remixes. |
| Bounded search and resolution | Staged providers, timeouts, cooldowns, negative caching, and bounded rescue attempts. |
| Open catalogs | Optional Openverse and Wikimedia Commons; Internet Archive support; optional Jamendo API. |
| Permanent personal library | Optional separate R2 `FLAC_BUCKET` for FLAC you upload and register yourself. |
| **Temporary FLAC cache** | Optional dedicated `FLAC_CACHE_BUCKET`, 36-hour TTL, background saving, signed playback links. |
| Diagnostics | Search/provider performance, failed matches, FLAC rescue, cache hits/misses/saves/skips/cleanup. |
| Existing track compatibility | Legacy provider IDs can still resolve; fresh searches provide richer matching metadata. |

**Verification nuance:** Public-catalog, personal-library, and cached-file paths check FLAC file signatures. Some third-party addon resolutions rely on reported format or URL metadata and cannot prove the audio bytes are FLAC until the file is fetched. The cache itself will not save a file unless its fetched bytes begin with `fLaC`.

## Architecture and playback flow

```text
BitChord
  │
  ├── GET /manifest.json                 → addon manifest
  ├── GET /search?q=...                  → configured providers + eligible cache entries
  │
  └── GET /stream/{provider}:{id}?quality=LOSSLESS
          │
          ├── Exact recording in R2 and younger than 36h?
          │      └── YES → signed /audio/cache/{hash}.flac URL
          │                → R2 streaming with byte-range support
          │
          └── NO → resolve from primary source
                    ├── Failed → search matching alternatives (FLAC only)
                    ├── No acceptable FLAC → HTTP error (no Worker-level lossy fallback)
                    └── Accepted stream → return original provider URL immediately
                                          └── Background R2 save, ONLY if:
                                              • resolved provider is allowlisted
                                              • caching is permitted by its terms/license
                                              • URL and file size pass safety checks
                                              • downloaded bytes begin with fLaC

Hourly Cron Trigger: 0 * * * *
  └── Delete R2 objects older than 36h; evict oldest if over 2 GiB target
```

A **cache miss does not delay playback for the purpose of saving**: the Worker returns the provider's stream information first. Cache writes happen opportunistically in the background and may not complete on slow downloads or when Worker execution limits are reached. A cached hit may require a fresh signed URL even though the R2 object itself lasts up to 36 hours.

**Important distinction:**

- `FLAC_BUCKET` = optional **personal permanent music library**. The 36-hour cleanup **must never** run against this bucket.
- `FLAC_CACHE_BUCKET` = dedicated **temporary cache** with 36-hour application expiry and hourly cleanup.

## Supported sources

| Source | Current status | Access / limitations |
| --- | --- | --- |
| Configured BitChord-compatible addons (`discord_0` etc.) | Existing | Use only sources you are authorized to access. Availability and FLAC authenticity vary. |
| **Internet Archive** (`ia`) | Included | Public archive metadata and qualifying FLAC files; rights vary by item. |
| **Jamendo** (`jamendo`) | Optional | Requires your own `JAMENDO_CLIENT_ID`; subject to API and licensing terms. |
| **Openverse** (`openverse`) | **Optional, added in v3.7.4** | Enable with `OPENVERSE_ENABLED=true`. Searches openly licensed media; coverage differs from commercial catalogs. |
| **Wikimedia Commons** (`commons`) | **Optional, added in v3.7.4** | Enable with `COMMONS_ENABLED=true`. Mainly openly licensed/public-domain audio. |
| **Personal R2 library** (`personal`) | Optional | Requires `FLAC_BUCKET` plus manually registered `PERSONAL_FLAC_TRACKS`. |
| **Private temporary R2 cache** (`cache`) | **Optional, added in v3.7.5** | Requires separate bucket, signed-link secret, and provider allowlist to save. |
| Funkwhale / Navidrome / LastWave | **Not integrated** | Discussed as possibilities only. They are **not** part of v3.7.5. |
| Qobuz / TIDAL as newly implemented direct integrations | **Not added** | No new commercial service integration or access-control bypass is included. |

Public-source integrations are designed to run only when needed rather than slowing successful fast searches. None guarantees a particular mainstream, Hardstyle, HOYO-MiX, or game-soundtrack recording.

## Deployment

### Requirements

- Cloudflare account with **Workers & Pages** access.
- Worker source `bit_chord_flac_private_cache_v3_7_5.js` from a **private, trusted copy**.
- Authorized upstream addon URLs.
- Optional R2 Standard bucket for the new cache (see below).
- Optional credentials/settings for Jamendo, Openverse, Wikimedia Commons, or personal R2 files.

### 1. Back up the current Worker and preserve source indexes

The packaged v3.7.5 source contains **eight original providers**, `discord_0` through `discord_7`. Previous logs from the live deployment also showed `discord_8`. If that ninth source is still configured, **merge it from your deployed Worker before replacing the code**.

Provider indexes appear in saved track IDs. Reordering or removing providers can break older tracks. Keep authorized providers in their existing positions.

> [!CAUTION]
> The packaged Worker code may include private or token-bearing upstream URLs. **Do not commit the raw `.js` file, ZIP package, or logs to a public GitHub repository.** Publish a sanitized version with placeholder URLs only; rotate any credentials already exposed.

### 2. Deploy the Worker

1. Open [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages**.
2. Select your existing BitChord Worker and back up its current code.
3. Merge any live-only providers without changing existing indexes.
4. Open **Edit Code**, paste the prepared v3.7.5 source, and **Deploy**.
5. Verify the manifest at:

   ```text
   https://YOUR-WORKER.workers.dev/manifest.json
   ```

   The manifest should report version `3.7.5` (allow for caching of previous manifest responses).

6. Keep using your existing Worker addon URL in BitChord. If the app needs a fresh manifest, refresh/reinstall the addon according to its UI.

**Deployment without R2:** The Worker should still operate as an aggregator. The 36-hour cache remains disabled until the necessary bindings/settings exist.

## 36-hour private FLAC cache: Cloudflare R2

This section configures the v3.7.5 addition. **R2 is object storage, not a relational song database.**

### 1. Create a separate private bucket

1. In Cloudflare, open **R2 Object Storage** → **Create bucket**.
2. Suggested name: `bitchord-flac-cache`. Any valid bucket name works.
3. Choose **Standard** storage, leaving default placement unless you have a reason to change it.
4. **Do not** enable public `r2.dev` access or a public custom domain for this bucket.
5. In your Worker, go to **Settings → Bindings → Add binding → R2 bucket**.
6. Set binding name **exactly** `FLAC_CACHE_BUCKET` and choose the new bucket.

Do not point `FLAC_CACHE_BUCKET` at your existing `FLAC_BUCKET` personal music library.

### 2. Add environment variables and secret

Open **Worker → Settings → Variables and Secrets** and set:

| Binding or variable | Type | Value / purpose |
| --- | --- | --- |
| `FLAC_CACHE_BUCKET` | **R2 bucket binding** | The dedicated private temporary-cache bucket. |
| `FLAC_CACHE_ENABLED` | Text variable | `true` to enable cache functionality. |
| `FLAC_CACHE_SIGNING_KEY` | **Secret** | Random **32+ character** secret for signed playback links. |
| `FLAC_CACHE_ALLOWED_PROVIDERS` | Text variable | Comma-separated provider IDs permitted to be cached, **after confirming caching rights**. Empty by default, which means no automatic copies. |
| `OPENVERSE_ENABLED` | Text variable, optional | `true` to enable Openverse search. |
| `COMMONS_ENABLED` | Text variable, optional | `true` to enable Wikimedia Commons search. |
| `JAMENDO_CLIENT_ID` | Secret, optional | Your authorized Jamendo API client ID. |

Generate a suitable signing key with a password manager or, locally:

```bash
openssl rand -base64 48
```

Store the actual key **only** as a Cloudflare secret. **Never place it in a public README, GitHub commit, chat screenshot, or JavaScript source file.**

**Safe rollout:** Set `FLAC_CACHE_ENABLED=true` with an **empty** `FLAC_CACHE_ALLOWED_PROVIDERS` list first. This allows verifying cache configuration without triggering copies. Enable individual providers only after verifying their terms and the relevant recording licenses. For example, `openverse,commons` is a *syntax illustration*, **not blanket permission** to cache every file indexed there.

### 3. Set the 36-hour hourly cleanup

In **Worker → Settings → Triggers → Cron Triggers**, add this expression:

```cron
0 * * * *
```

This invokes the existing `scheduled()` handler **hourly, on UTC hour boundaries**. Each R2 object has its own 36-hour timestamp from cache upload. The Worker refuses to serve it as soon as that timestamp passes; the next successful scheduled cleanup physically removes it.

If deploying using Wrangler, preserve your existing configuration and add:

```toml
[triggers]
crons = ["0 * * * *"]
```

For extra orphan protection if Cron cleanup fails, you may separately apply an **R2 lifecycle policy** to expire objects under `bc-flac-cache-v1/` after **2 days**. It is a safety net, **not** the exact 36-hour expiry mechanism. Physical removal after the 36-hour point is not guaranteed at an exact minute if a scheduled run is delayed or fails.

### 4. Cache policy and safety limits

| Property | v3.7.5 behavior |
| --- | --- |
| Retention | **36 hours** from upload; no serving expired cache objects. |
| Cleanup | Hourly Worker Cron Trigger. |
| Cache target | **2 GiB** total, best-effort, not a hard concurrent quota. |
| Maximum individual file | **100 MiB**. |
| Unknown `Content-Length` | Not cached. |
| Actual file type | Cached only when downloaded bytes start with FLAC `fLaC` magic. |
| Upstream restrictions | Only providers explicitly allowed by `FLAC_CACHE_ALLOWED_PROVIDERS`. |
| First-time playback | Returns original stream immediately; background cache save may fail. |
| Cache link lifetime | HMAC-signed, up to **6 hours** or sooner if R2 object expires. |
| Playback methods | `GET`, `HEAD`; HTTP `Range` supported. |
| R2 object keys | Hashed under `bc-flac-cache-v1/`; not labeled with the song title in the filename. |
| R2 metadata | Stores title, artist, album, duration, source provider, and expiry for cached search. |
| Public R2 bucket | **Not required and not recommended.** |

**Not a strict spending cap:** 2 GiB is an application target, not a Cloudflare-enforced capacity ceiling. Simultaneous uploads can briefly exceed it, and Cloudflare billing is based on actual storage and operations. The R2 cache is **personal-use oriented**, not a public unlimited cache service.

## Other optional integrations

### Openverse and Wikimedia Commons

Set `OPENVERSE_ENABLED=true` and/or `COMMONS_ENABLED=true` under Worker text variables. The Worker searches these public catalogs when fast search results are insufficient. Returned titles are candidates; actual FLAC availability is checked during resolution.

These services contain open-licensed/public-domain material, not necessarily mainstream catalog releases. **A free-to-listen or openly indexed file is not automatically free to copy**; follow the license and attribution requirements of each actual recording.

### Jamendo

1. Obtain your own client ID through the [Jamendo developer portal](https://devportal.jamendo.com/).
2. Create a Worker secret named `JAMENDO_CLIENT_ID`.
3. Search normally in BitChord; availability depends on API and track access.

### Permanent personal FLAC library (separate from cache)

Bind a **different** R2 bucket as `FLAC_BUCKET` and register your own authorized tracks in `PERSONAL_FLAC_TRACKS`:

```js
const PERSONAL_FLAC_TRACKS = [
  { key: "MyMusic/Artist - Song.flac", title: "Song", artist: "Artist", duration: 240 }
];
```

The personal-library route `/audio/personal/{index}.flac` streams direct R2 bytes with range support. **Unlike the signed temporary cache, this route is publicly accessible to someone who knows the URL** in the current implementation. Use it only for files you have permission to expose, or add compatible access controls before use.

## API routes

| Method | Route | Response |
| --- | --- | --- |
| `GET` | `/manifest.json` | BitChord addon metadata; version `3.7.5`. |
| `GET` | `/search?q=artist+title` | JSON with `tracks` array, possibly including valid cache entries. |
| `GET` | `/stream/{provider}:{trackId}?quality=LOSSLESS` | FLAC stream metadata/URL, or an HTTP error when no accepted FLAC is available. |
| `GET`, `HEAD` | `/audio/cache/{hash}.flac?exp=...&sig=...` | Signed, unexpired cache audio with range support. Do not publish the URL. |
| `GET` | `/audio/personal/{index}.flac` | Bytes from the optional *permanent* personal R2 library. |

Example search:

```text
https://YOUR-WORKER.workers.dev/search?q=Make%20Me%20Stay%20Original%20Mix&quality=LOSSLESS
```

The `/search` response can contain tracks whose providers **claim** lossless quality. `/stream` resolution still can fail when a matching playable file is unavailable.

## Live monitoring and testing

### See the actual files

Cloudflare Dashboard → **R2 Object Storage** → your temporary-cache bucket → **Objects**, then refresh. Cached objects appear under the prefix `bc-flac-cache-v1/`, using hashed `.flac` names. No object will be written unless all cache prerequisites are satisfied and a permitted FLAC copy succeeds.

### Follow live Worker logs

Cloudflare Dashboard → **Workers & Pages → your Worker → Observability / Logs → Live** (labels can vary).

| Log marker | Meaning |
| --- | --- |
| `[FLAC CACHE MISS]` | No currently usable cached object matched the requested recording. |
| `[FLAC READY]` | Upstream FLAC stream was resolved; **not proof that a copy was stored**. |
| `[FLAC CACHE SAVED]` | A permitted FLAC object was written to R2. |
| `[FLAC CACHE HIT]` | Stream resolution reused a valid R2 cache object. |
| `[FLAC CACHE SKIP]` | A cache write or lookup was skipped/failed; inspect the reason. |
| `[FLAC CACHE CLEANUP] expired=N evicted=M` | Scheduled job removed expired and/or excess objects. |
| `[FLAC RESCUE SUCCESS]` | A different matched provider supplied an accepted stream. |
| `[FLAC RESCUE EXHAUSTED]` | No successful matched alternative was found. |
| `[NO FLAC]` | No acceptable FLAC stream was found. |

**Suggested real-world test:**

1. Back up v3.7.4/v3.7.5 settings, deploy v3.7.5, and verify `/manifest.json`.
2. Enable the private R2 cache and one **specifically authorized** cache provider.
3. Search and play a song for which that provider legally permits caching.
4. Confirm `[FLAC READY]`, then **`[FLAC CACHE SAVED]`** and a new object in R2. The first-play save may complete later or fail; do not infer success from playback alone.
5. Re-search/play the **same recording** and look for `[FLAC CACHE HIT]`.
6. Check that seeking works on cached audio via HTTP Range playback.
7. Test the hourly Cron Trigger and watch for `[FLAC CACHE CLEANUP]`.

**Reference tracks:** “Make Me Stay (Original Mix)” is useful for testing correct recording-version matching; previous live playback showed a FLAC badge, but also warrants checking duration against the intended version. The HOYO-MiX soundtrack test previously had many metadata candidates but **no confirmed playable FLAC**. Caching does not create unavailable music.

### Test coverage

At preparation time, **57/57 local mocked tests passed** across regression search, soundtrack matching, recording matching, public catalog adapters, and the new cache scenarios. This is **not** proof of a live Cloudflare deployment, actual R2 file persistence, signed-URL playback inside BitChord, or commercial music availability. Complete the real-device test above before declaring production operation verified.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Cache bucket stays empty | `FLAC_CACHE_ENABLED`, `FLAC_CACHE_BUCKET`, signing key length, explicit provider allowlist, caching rights, and `[FLAC CACHE SKIP]` logs. |
| `[FLAC READY]` but no saved object | Normal if provider is not allowed, the download exceeds limits, file is not actual FLAC, or background upload failed. |
| `[FLAC CACHE SKIP] reason=size_unknown_or_exceeds_limit` | Source did not send trustworthy `Content-Length`, or the file is larger than 100 MiB. |
| `[FLAC CACHE SKIP] reason=not_flac_bytes` | Source did not deliver a real FLAC header. Do not bypass this check. |
| `[FLAC CACHE SKIP] reason=storage_budget` | 2 GiB cache target reached, or listing couldn't establish a safe total. Let hourly cleanup run. |
| `[FLAC CACHE SKIP] reason=download_or_r2_error` | Audio download or R2 write failed; review network/R2 health and background execution limits. |
| Cache URL returns `403` | Signature missing/invalid, URL expired, or signing key changed. Request a new `/stream` URL. |
| Cache URL returns `404` | Object missing, cache disabled, or its 36-hour TTL expired. Re-resolve from upstream. |
| Cron logs missing | Confirm `0 * * * *` is attached to **this deployed Worker**, and the `scheduled()` handler exists. |
| Source returns `404`, `429`, or `502` | Track unavailable, upstream rate-limited, or upstream gateway failed; try other authorized sources. |
| Wrong edit/mix selected | Re-search with the exact title/version; inspect artist and duration matching. |
| HOYO-MiX still unavailable | There may be no matching reachable FLAC source; metadata results alone do not prove availability. |
| BitChord plays Opus despite Worker FLAC-only rules | BitChord itself may select another addon/source. Review app-level playback/fallback behavior. |
| Openverse/Commons missing | Confirm feature variable is `true`; public catalogs may be queried only after first-tier search results are insufficient. |
| Existing provider disappeared after update | Check whether live-only `discord_8` was lost while deploying packaged eight-provider source. Restore original index. |

**Keep logs private:** Redact signed URLs, addon tokens, authorization headers, user/account IDs, and other personal data before posting support examples.

## Costs, security, and copyright

- **Personal use is not automatic access control.** A `workers.dev` URL may be reachable by anyone who knows it. The temporary R2 bucket itself should stay private; cache audio URLs are signed but can be replayed by anyone holding a valid unexpired link.
- **Avoid public code leaks.** This project's private Worker source may contain upstream URLs with embedded tokens. Sanitize before pushing to GitHub; rotate exposed credentials.
- **Free tier is not a hard spending cap.** R2 Standard has usage allowances, but storage and operation overages can be billed. Monitor R2 usage and configure billing alerts. Cloudflare Workers have separate limits.
- **The 2 GiB limit is approximate.** It is a Worker-level budget, not a strict atomic quota under concurrent uploads.
- **36-hour expiry is enforced during reads.** Physical deletion normally occurs on an hourly cleanup but may be delayed by failed/late scheduled jobs.
- **Only cache authorized audio.** A free stream or public catalog entry doesn't automatically grant rehosting/copying permission. Apply track-specific terms, licenses, attribution, and any restrictions on temporary storage.
- **No access-control circumvention.** Do not adapt protected subscriptions, app-locked streaming services, or third-party credentials without authorization.
- **No unconditional FLAC guarantee.** Third-party addon stream metadata can be wrong; only cached files are checked from actual byte signatures before saving.
- **No license automatically implied.** A public repo without an explicit `LICENSE` file does not grant general reuse rights.

## Release history

| Version | Main improvement |
| --- | --- |
| **v3.7.5** | **36-hour private R2 cache**, signed cached-audio playback, optional background saving, per-provider allowlist, hourly cleanup, 2 GiB target. |
| **v3.7.4** | Optional free public catalogs: **Openverse** and **Wikimedia Commons**. |
| **v3.7.3** | Version-aware recording matching and clearer mismatch diagnostics. |
| **v3.7.2** | Game-soundtrack search and matching improvements. |
| **v3.7.1** | Faster staged searches and better performance under slow upstreams. |
| **v3.7.0** | Jamendo, Internet Archive and optional permanent R2 personal-library support. |
| **v3.6.1** | Provider cooldown, ordering, and additional recovery search. |
| **v3.6.0** | Faster resolution and stricter known-lossy rejection. |
| **v3.5.0** | Cross-provider FLAC rescue and matching. |

## Documentation

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [R2 bucket bindings / Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Openverse API](https://api.openverse.org/v1/)
- [Wikimedia Commons API](https://www.mediawiki.org/wiki/API:Main_page)
- [Jamendo API](https://developer.jamendo.com/v3.0/tracks)
- [Internet Archive developer resources](https://archive.org/developers/)

---

**Made for more reliable personal lossless listening, with respect for artists, permissions, and providers.** 🎵

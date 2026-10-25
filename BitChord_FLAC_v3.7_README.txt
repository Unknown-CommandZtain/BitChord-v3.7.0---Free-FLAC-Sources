BitChord v3.7.0 - Free FLAC Sources
==================================

IMPORTANT
- This update preserves your eight existing upstream addon entries and their indexes.
- Your existing URLs may contain private access tokens. Do not publish or share the Worker source unredacted.
- No paid streaming service is integrated. Strict FLAC-only selection is retained.
- Newly listed Jamendo and Internet Archive tracks are verified with the FLAC "fLaC" file signature before returning a stream URL.
- Existing third-party provider tracks still rely on their stated FLAC format and URL metadata; the Worker cannot verify the bytes of those streams without additional requests.
- Live provider availability and playback in the BitChord app were not tested. Local mocked tests passed.

QUICK INSTALL (no payment, no new credentials)
1. Back up your working v3.6.1 Cloudflare Worker.
2. Replace its script with bit_chord_flac_free_sources_v3_7.js.
3. Deploy it. The existing providers and Internet Archive search work without any new setup.
4. Search again for tracks in BitChord to generate the new source-aware track IDs.
5. Observe Cloudflare logs. If a song doesn't have a verified FLAC source, the addon will return a failure rather than AAC/MP3/Opus.

ADD JAMENDO FREE ACCESS (OPTIONAL)
1. Register for a developer application at https://devportal.jamendo.com/ .
2. Get YOUR OWN free read-only API client ID. Do not use the shared demonstration client ID in production.
3. Cloudflare Dashboard -> Workers & Pages -> your Worker -> Settings -> Variables and Secrets -> Add.
4. Name: JAMENDO_CLIENT_ID; Value: your client ID. A Secret is fine, or a text variable if permitted by the developer terms.
5. Deploy the new setting, then search for independent music in BitChord.
6. The Worker requests audioformat=flac and verifies the file signature. It does not download entire audio files.
Jamendo's API is free for eligible noncommercial use under its terms; rate limits and licensing restrictions still apply.
Docs: https://developer.jamendo.com/v3.0/tracks
Terms: https://devportal.jamendo.com/api_terms_of_use

INTERNET ARCHIVE
- Enabled by default: no account needed.
- Only exposes concrete .flac files in archives whose filenames and creator closely match the query. No "first file in archive" guessing.
- A collection may contain no usable FLAC song matches, and search may be slower than an existing indexed provider.

OPTIONAL PERSONAL FLAC LIBRARY (R2)
- NOT required for the free public sources.
- R2 Standard storage has monthly free allowances. Cloudflare may require billing enrollment; exceeding the free allowances can incur charges.
- Enable R2 only if you accept the account/billing requirements. See https://developers.cloudflare.com/r2/pricing/ .
1. In your Cloudflare account, create a Standard-class R2 bucket (for example 'bit-chord-personal').
2. Upload .flac audio files you own or are authorized to stream.
3. Bind that bucket to your Worker under the exact binding name FLAC_BUCKET (Settings -> Bindings -> Add binding -> R2 Bucket).
4. Edit the PERSONAL_FLAC_TRACKS array near the top of the JavaScript, for example:
   const PERSONAL_FLAC_TRACKS = [
     { key: "Artist - Song.flac", title: "Song", artist: "Artist", duration: 240 }
   ];
   The key must match the exact R2 object key and end in .flac.
5. Deploy again. Search for that track in BitChord.
6. The Worker validates the first four R2 bytes and serves FLAC using Range support at /audio/personal/N.flac.
WARNING: The /audio/personal/N.flac endpoints are public. Anyone with the URLs can stream those files. Do not use for confidential/private audio or content you're not allowed to redistribute.

DESIGN NOTES
- Jamendo disabled automatically when JAMENDO_CLIENT_ID is missing.
- Personal R2 library disabled automatically when FLAC_BUCKET isn't bound and the PERSONAL_FLAC_TRACKS array is empty.
- Preexisting discord_0-7 provider ordering, metadata-bearing IDs, and legacy track IDs are preserved.
- Cross-provider FLAC rescue works with compatible Jamendo, Archive, personal-library, and original-provider entries when enough song metadata is available.
- Lossless-only applies to what this Worker returns. BitChord can independently select other installed music sources (including Opus/YouTube); disable app-level lossy fallbacks separately.

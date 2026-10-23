# Timeline preview performance

## Preview path

Timeline playback now renders a five-second, frame-aligned section containing the playhead. The next section is rendered in the background and is usually ready before the current section ends. The renderer translates the MP4's local timestamps back to exact project seconds. Video and audio are produced together from the same filter graph used by final export, keeping their sync and existing clip effects consistent.

Preview MP4s use a maximum 960-pixel output width, at most 24 FPS, and default bitrates of 3500 kbit/s video and 160 kbit/s audio. `exportVideo` defaults to the unchanged full-project/final-quality mode. Its optional exact rational `range` and `quality: 'preview'` parameters let the desktop use the shared renderer without maintaining a second effect implementation.

The cache key contains the project profile, range, preview quality, active tracks and only clips intersecting that range, plus the referenced media paths and import identity/metadata. A change outside a section therefore leaves that section reusable; a change to an intersecting clip or track setting produces a new key. A frame preview uses the same range-scoped key and frame number, so repeated `preview_render` and `preview_analyze` requests reuse the rendered image and signal statistics.

Playback requests are cancellable. A new range request or a timeline edit aborts stale FFmpeg work; temporary MP4s are removed on cancellation and only verified output is renamed to its cache path. Playback cache cleanup retains at most 24 MP4s / 512 MiB and removes entries older than 14 days. Still-frame caches retain at most 120 frames / 128 MiB for 14 days. These limits apply within the project's existing cache directory; original media and project files are never cache targets.

## Reproducible benchmark

Run `npm run benchmark:preview`. The script creates a 320×180 synthetic FFmpeg source, tests 10- and 60-second timelines, measures full final renders and five-second preview sections, repeats the request, edits a clip outside the selected section, then edits an intersecting clip. It writes the raw measurements to `reports/preview-performance-latest.json`.

The pre-change numbers below were measured on Windows before the range implementation, using the full-timeline renderer for both the initial render and the render after an edit. The new measurements are from the same Windows host and synthetic fixture. Timings vary with system load.

| Timeline | Before: full render | Before: after edit | Preview cache miss | After edit inside range | Unchanged range after outside edit |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 s | 327.8 ms | 339.7 ms | 225.7 ms (31.1% faster) | 218.9 ms (35.6% faster) | 0.1 ms (cache hit) |
| 60 s | 1339.0 ms | 1336.6 ms | 223.7 ms (83.3% faster) | 222.3 ms (83.4% faster) | 0.1 ms (cache hit) |

An identical preview request is a cache hit. The benchmark measures the key lookup and file check as well as FFmpeg render time; a cache hit does not launch FFmpeg. The report also records the output size, preview-cache size and sampled Node RSS. RSS is sampled around the benchmark and does not include a peak measurement of the separate FFmpeg child process. Cache budget enforcement is covered by a deterministic test.

On the 23 October 2026 run, the benchmark Node process RSS moved from 46.2 MiB to 50.0 MiB (+3.8 MiB); the separate FFmpeg working set is not included. The generated preview entries used about 1.9 MiB per project case. Playback cache enforcement remains capped at 512 MiB and 24 entries. Raw details and environment are in [`reports/preview-performance-latest.json`](reports/preview-performance-latest.json).

## Limits and real-time assessment

This is a responsive proxy workflow, not a real-time compositor: FFmpeg still renders each changed five-second section before that section is playable. Background rendering of the next section hides most boundary gaps during ordinary playback. Frame stepping and seeking show a full-resolution still frame.

A true live preview would need to run the existing FFmpeg composition graph as a stream into the monitor and handle seeks, edits, decoder buffering, and cancellation. Replacing that graph with a browser/GPU implementation would duplicate the many existing filters (speed curves, keyframes, masks, blend modes, transitions, LUTs, titles, and audio automation) and risks preview/export drift. A streaming adapter around the shared FFmpeg graph is technically possible, but it is a separate performance project; the measured range/cache gains make it unnecessary for this first optimization.

Measurements in this file are Windows-only. Linux and macOS behavior was not exercised in this run. The automated tests use synthetic media and verify range cache invalidation, preview output size, audio/video start synchronization, cancellation cleanup, and cache limits; they do not measure subjective visual quality or playback smoothness on every GPU/codec combination.

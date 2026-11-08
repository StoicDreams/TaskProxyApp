# Website screenshots and videos

Captures the screenshots and videos used in the TaskProxy.com tutorials, by driving the real UI against the mock backend from `tests/support`, filled with a made-up project from `demo.mjs`.

```bash
npm run capture                         # Everything
npm run capture -- screenshots          # Screenshots only
npm run capture -- videos -g "commit"   # One video, by name
```

- **Output:** files go to `../../Websites/TaskProxy/webapp/root_files`, the website checkout beside this repo, as `img/tutorials/*.webp` and `video/*.mp4` with a `.webp` poster. Set `CAPTURE_OUT` to write somewhere else.
- **Needs:** `ffmpeg` with `libx264` and `libwebp`, and network access for the Web UI CDN. Set `WEBUI_CDN_ROOT` to capture against a MyFiCDN checkout.
- **Source files:** captures use the source files, not the `.min.js` files, so they show changes that are not minified yet.

## Files

- `demo.mjs`: the demo project, its pages, scripts, git changes, and sample terminal output.
- `helpers.mjs`: `shot` for screenshots, `record` for videos, and the cursor, caption, and simulated script output used in videos.
- `screenshots.capture.mjs` and `videos.capture.mjs`: one test per screenshot or video, named after what it shows.

Videos are recorded from Chrome's screencast rather than Playwright's built-in video, which is much blurrier, then encoded with ffmpeg. Playwright does not draw the mouse, so `prepare` adds a pointer and caption overlay to the page.

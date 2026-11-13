# Website images and videos

Captures the media on TaskProxy.com by driving the real UI against the mock backend from `tests/support`, filled with a made-up project from `demo.mjs`. `PowerShell/Publish.ps1` runs all of it through `PowerShell/screenshots.ps1` on every publish, so the site always shows the current UI. Leave it out with `Publish.ps1 -SkipScreenshots` (or `-SkipMedia`) when a commit's UI changes aren't worth new recordings.

```bash
npm run capture                         # Everything, as screenshots.ps1 and Publish.ps1 run it
npm run capture -- loops                # Only the loops
npm run capture -- loops -g "branches"  # One loop, by name
npm run capture -- videos               # Only the narrated tutorial videos
```

- **Loops, not screenshots:** an image that promotes Task Proxy or documents an action is a short looping video of that action (`loops.capture.mjs`), shown on the site with `<webui-loop-video>` from the Web UI CDN. It plays muted on a loop while on screen, and shows its poster, the last frame, to visitors who ask for less motion. Use a still screenshot (`shot`) only for a view where nothing happens.
- **Output:** files go to `../../Websites/TaskProxy/webapp/root_files`, the website checkout beside this repo: loops as `video/loops/<name>.mp4` (plugins under `video/loops/<plugin>/`), tutorial videos as `video/<name>.mp4`, each with a `.webp` poster. Set `CAPTURE_OUT` to write somewhere else.
- **Every run replaces every file.** Recordings never come out byte for byte the same, so git shows them all as changed. Commit them when the UI changed enough to be worth it, or discard them.
- **Time:** about 8 minutes for everything. `CAPTURE_WORKERS` sets how many recordings run at once (3 by default); use 1 on a slow machine if recordings stutter.
- **Needs:** `ffmpeg` with `libx264` and `libwebp`, and network access for the Web UI CDN. Set `WEBUI_CDN_ROOT` to capture against a MyFiCDN checkout.
- **Source files:** captures use the source files, not the `.min.js` files, so they show changes that are not minified yet.

## Files

- `demo.mjs`: the demo project, its pages, scripts, git changes, and sample terminal output.
- `helpers.mjs`: `loop` and `record` for videos, `shot` for the rare still, and the pointer, captions, and simulated script output.
- `loops.capture.mjs`: one loop per action shown on the site, named after the file it writes. Each ends on the result, which becomes its poster.
- `videos.capture.mjs`: the longer tutorial videos, with captions.
- `fixtures/jira/`: the Jira plugin's own screens for made-up data, which its loops draw. Refresh them with `cargo run -p taskproxy-jira --example demo -- ../TaskProxyApp/tools/capture/fixtures/jira` in TaskProxyPlugins, which its `scripts/publish.ps1` also does.

Videos are recorded from Chrome's screencast rather than Playwright's built-in video, which is much blurrier, then encoded with ffmpeg. Playwright does not draw the mouse, so `prepare` adds a pointer and caption overlay to the page.

Every Stoic Dreams website should work this way: its Publish script regenerates its media from the real UI, and actions are shown as loops rather than screenshots.

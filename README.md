# Replay

Replay is a private, browser-based delayed camera viewer for gymnastics coaching and skill review. Camera video is processed on the device and is not uploaded by the application.

## Use

1. Open the HTTPS site in a current version of Safari, Chrome, or Edge.
2. Select a replay delay and press **Start camera**.
3. Approve camera access when the browser asks.
4. Wait for the replay buffer to fill.
5. To create a clip, choose its length and press **Record next N seconds**. This records the delayed view beginning at that moment.

## Privacy

- Replay requests video only; microphone audio is disabled.
- Video frames and replay data remain in the browser.
- The application has no server, accounts, analytics, ads, or third-party scripts.
- Downloaded clips become normal files on the device. Users are responsible for consent, retention, sharing, and deletion under their organization's policies.

## Replay engines

The preferred engine records an on-device processing canvas into compressed one-second chunks and feeds those chunks to Media Source Extensions after the selected delay. A browser must support the same MIME type through both `MediaRecorder` and `MediaSource`.

When that combination is unavailable, Replay uses a deliberately limited compatibility mode: 240p, 15 FPS, and a maximum three-second delay. This prevents the multi-gigabyte raw-frame buffers used by the original prototype.

## Browser targets

The primary target is a current iPad running Safari. Current Chrome and Edge are secondary targets. Browser media APIs differ, so changes should be checked on real devices before being deployed for practice.

Suggested release checklist:

- Camera permission can be approved and denied cleanly.
- Front/rear camera switching works.
- Ten-, 30-, 60-, and 120-second delays remain stable.
- Delay changes restart the replay buffer and show the new warm-up state.
- An eight-second clip downloads and plays in the device's standard player.
- Stopping the camera releases the camera indicator and screen wake lock.
- The site installs and starts in standalone mode.

## Local development

Camera access requires HTTPS or localhost. From the repository directory, serve the files through any local static server rather than opening `index.html` directly.

Example:

```bash
npx serve .
```

Then open the localhost URL shown in the terminal.

## Project structure

```text
index.html             Interface and accessible page structure
css/app.css            Responsive application styling
js/app.js              Camera, delay, replay, clip, and install logic
manifest.webmanifest   Installable app metadata
sw.js                  Offline application-shell cache
icons/                 App and installation icons
```

## Deployment

The production site is served by GitHub Pages from the repository's default branch. Test an improvement branch before merging it into `main`.

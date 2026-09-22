(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const ui = {
    live: $('liveVideo'), delayedVideo: $('delayedVideo'), delayedCanvas: $('delayedCanvas'),
    processingCanvas: $('processingCanvas'), clipCanvas: $('clipCanvas'), viewer: $('viewer'),
    viewerMessage: $('viewerMessage'), start: $('startBtn'), stop: $('stopBtn'), flip: $('flipBtn'),
    mirror: $('mirrorBtn'), fullscreen: $('fullscreenBtn'), install: $('installBtn'),
    delay: $('delayRange'), delayValue: $('delayValue'), delayBadge: $('delayBadge'), restartNote: $('restartNote'),
    camera: $('cameraSelect'), captureResolution: $('captureResolution'), replayResolution: $('replayResolution'),
    captureFps: $('captureFps'), clipLength: $('clipLength'), recordClip: $('recordClipBtn'),
    download: $('downloadLink'), toast: $('toast'), connectionBadge: $('connectionBadge'),
    engineBadge: $('engineBadge'), actualBadge: $('actualBadge'), cameraStatus: $('cameraStatus'),
    replayStatus: $('replayStatus'), bufferStatus: $('bufferStatus')
  };

  const state = {
    stream: null, recorder: null, mediaSource: null, sourceBuffer: null,
    mediaSourceUrl: '', downloadUrl: '', chunks: [], nextSequence: 0, sequence: 0,
    frameCallback: null, frameTimer: null, playbackTimer: null, clipFrame: null,
    fallbackFrames: [], fallbackWrite: 0, fallbackSeen: 0,
    facingMode: 'environment', mirrored: false, running: false, generation: 0,
    replayFps: 30, delaySeconds: 10, deferredInstall: null, wakeLock: null,
    toastTimer: null, engine: 'none'
  };

  const parseResolution = value => {
    const [width, height] = value.split('x').map(Number);
    return { width, height };
  };
  const plural = (value, word) => `${value} ${word}${value === 1 ? '' : 's'}`;

  function showToast(message, duration = 5000) {
    clearTimeout(state.toastTimer);
    ui.toast.textContent = message;
    ui.toast.hidden = false;
    state.toastTimer = setTimeout(() => { ui.toast.hidden = true; }, duration);
  }

  function showViewerMessage(title, detail) {
    ui.viewerMessage.innerHTML = '';
    const strong = document.createElement('strong');
    const span = document.createElement('span');
    strong.textContent = title;
    span.textContent = detail;
    ui.viewerMessage.append(strong, span);
    ui.viewerMessage.hidden = false;
  }

  function hideViewerMessage() { ui.viewerMessage.hidden = true; }

  function updateDelayText() {
    const seconds = Number(ui.delay.value);
    ui.delayValue.textContent = plural(seconds, 'second');
    ui.delayBadge.textContent = `${plural(seconds, 'second')} behind`;
  }

  function setRunningUi(running) {
    ui.start.disabled = running;
    ui.stop.disabled = !running;
    ui.flip.disabled = !running;
    ui.recordClip.disabled = !running;
    ui.connectionBadge.textContent = running ? 'Camera active' : 'Ready';
  }

  function compatibleMimeTypes() {
    if (!window.MediaRecorder || !window.MediaSource || !MediaRecorder.isTypeSupported || !MediaSource.isTypeSupported) return [];
    return [
      'video/webm;codecs=vp8',
      'video/webm;codecs=vp9',
      'video/webm',
      'video/mp4;codecs="avc1.42E01E"',
      'video/mp4'
    ].filter(type => MediaRecorder.isTypeSupported(type) && MediaSource.isTypeSupported(type));
  }

  async function enumerateCameras(selectedId = '') {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
      ui.camera.innerHTML = '';
      for (const [index, device] of devices.entries()) {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Camera ${index + 1}`;
        option.selected = device.deviceId === selectedId;
        ui.camera.append(option);
      }
      if (!devices.length) ui.camera.add(new Option('Default camera', ''));
    } catch (error) {
      console.warn('Could not list cameras', error);
    }
  }

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try { state.wakeLock = await navigator.wakeLock.request('screen'); }
    catch (error) { console.info('Wake lock unavailable', error); }
  }

  async function releaseWakeLock() {
    try { await state.wakeLock?.release(); } catch {}
    state.wakeLock = null;
  }

  function stopFramePump() {
    if (state.frameCallback !== null && ui.live.cancelVideoFrameCallback) ui.live.cancelVideoFrameCallback(state.frameCallback);
    if (state.frameTimer !== null) clearInterval(state.frameTimer);
    state.frameCallback = null;
    state.frameTimer = null;
  }

  function drawContained(source, canvas) {
    const sourceWidth = source.videoWidth || source.width;
    const sourceHeight = source.videoHeight || source.height;
    if (!sourceWidth || !sourceHeight || !canvas.width || !canvas.height) return;
    const context = canvas.getContext('2d', { alpha: false });
    const scale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
    const width = Math.round(sourceWidth * scale);
    const height = Math.round(sourceHeight * scale);
    const x = Math.round((canvas.width - width) / 2);
    const y = Math.round((canvas.height - height) / 2);
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, sourceWidth, sourceHeight, x, y, width, height);
  }

  function startFramePump() {
    stopFramePump();
    const generation = state.generation;
    const draw = () => {
      if (!state.running || generation !== state.generation) return;
      drawContained(ui.live, ui.processingCanvas);
      if (ui.live.requestVideoFrameCallback) state.frameCallback = ui.live.requestVideoFrameCallback(draw);
    };
    if (ui.live.requestVideoFrameCallback) state.frameCallback = ui.live.requestVideoFrameCallback(draw);
    else state.frameTimer = setInterval(() => drawContained(ui.live, ui.processingCanvas), 1000 / state.replayFps);
  }

  function stopReplayEngine() {
    state.generation += 1;
    stopFramePump();
    if (state.playbackTimer !== null) clearInterval(state.playbackTimer);
    state.playbackTimer = null;
    if (state.recorder && state.recorder.state !== 'inactive') {
      state.recorder.ondataavailable = null;
      try { state.recorder.stop(); } catch {}
    }
    state.recorder = null;
    if (state.sourceBuffer) {
      try { state.sourceBuffer.removeEventListener('updateend', pumpCompressedReplay); } catch {}
      try { if (!state.sourceBuffer.updating) state.sourceBuffer.abort(); } catch {}
    }
    state.sourceBuffer = null;
    try { if (state.mediaSource?.readyState === 'open') state.mediaSource.endOfStream(); } catch {}
    state.mediaSource = null;
    if (state.mediaSourceUrl) URL.revokeObjectURL(state.mediaSourceUrl);
    state.mediaSourceUrl = '';
    state.chunks = [];
    state.nextSequence = 0;
    state.sequence = 0;
    for (const frame of state.fallbackFrames) frame.width = frame.width;
    state.fallbackFrames = [];
    state.fallbackWrite = 0;
    state.fallbackSeen = 0;
    state.engine = 'none';
    ui.delayedVideo.pause();
    ui.delayedVideo.removeAttribute('src');
    ui.delayedVideo.load();
    ui.delayedCanvas.hidden = true;
    ui.delayedVideo.hidden = false;
  }

  function trimCompressedChunks() {
    if (!state.chunks.length) return;
    const latest = state.chunks[state.chunks.length - 1].sequence;
    const keepAfter = latest - state.delaySeconds - 15;
    while (state.chunks.length && state.chunks[0].sequence < keepAfter && state.chunks[0].sequence < state.nextSequence) state.chunks.shift();
  }

  function pumpCompressedReplay() {
    const buffer = state.sourceBuffer;
    if (!buffer || buffer.updating || state.mediaSource?.readyState !== 'open' || !state.chunks.length) return;
    try {
      if (buffer.buffered.length && ui.delayedVideo.currentTime > 45) {
        const removeBefore = Math.max(0, ui.delayedVideo.currentTime - 30);
        if (buffer.buffered.start(0) < removeBefore) {
          buffer.remove(buffer.buffered.start(0), removeBefore);
          return;
        }
      }
    } catch {}
    const latestSequence = state.chunks[state.chunks.length - 1].sequence;
    const targetSequence = latestSequence - state.delaySeconds;
    ui.bufferStatus.textContent = plural(Math.min(latestSequence + 1, state.delaySeconds), 'second');
    if (targetSequence < 0) {
      ui.replayStatus.textContent = `Warming up ${Math.abs(targetSequence)}s`;
      return;
    }
    const chunk = state.chunks.find(item => item.sequence === state.nextSequence);
    if (!chunk || chunk.sequence > targetSequence) return;
    chunk.blob.arrayBuffer().then(data => {
      if (!state.sourceBuffer || state.sourceBuffer.updating) return;
      try {
        state.sourceBuffer.appendBuffer(data);
        state.nextSequence += 1;
        ui.delayedVideo.play().catch(() => {});
        hideViewerMessage();
        ui.replayStatus.textContent = 'Playing';
      } catch (error) {
        console.error('Replay append failed', error);
        ui.replayStatus.textContent = 'Playback error';
        showToast('The browser stopped the compressed replay. Stop and restart the camera.');
      }
    });
  }

  function startCompressedReplay(mimeType) {
    state.engine = 'compressed';
    ui.engineBadge.textContent = 'Compressed replay';
    ui.delayedCanvas.hidden = true;
    ui.delayedVideo.hidden = false;
    state.mediaSource = new MediaSource();
    state.mediaSourceUrl = URL.createObjectURL(state.mediaSource);
    ui.delayedVideo.src = state.mediaSourceUrl;
    const generation = state.generation;
    state.mediaSource.addEventListener('sourceopen', () => {
      if (generation !== state.generation || !state.mediaSource) return;
      try {
        state.sourceBuffer = state.mediaSource.addSourceBuffer(mimeType);
        state.sourceBuffer.mode = 'sequence';
        state.sourceBuffer.addEventListener('updateend', pumpCompressedReplay);
      } catch (error) {
        console.error('SourceBuffer unavailable', error);
        startFallbackReplay('This browser could not open its compressed replay format.');
      }
    }, { once: true });

    const output = ui.processingCanvas.captureStream(state.replayFps);
    try {
      state.recorder = new MediaRecorder(output, { mimeType, videoBitsPerSecond: 1_800_000 });
    } catch (error) {
      console.error('MediaRecorder unavailable', error);
      startFallbackReplay('This browser could not start compressed recording.');
      return;
    }
    state.recorder.ondataavailable = event => {
      if (generation !== state.generation || !event.data?.size) return;
      state.chunks.push({ sequence: state.sequence++, blob: event.data });
      trimCompressedChunks();
      pumpCompressedReplay();
    };
    state.recorder.onerror = event => {
      console.error('MediaRecorder error', event.error);
      showToast('The camera encoder reported an error. Try 480p replay quality.');
    };
    state.recorder.start(1000);
    startFramePump();
    ui.replayStatus.textContent = 'Warming up';
    showViewerMessage('Building replay buffer', `The delayed view will begin in ${plural(state.delaySeconds, 'second')}.`);
  }

  function startFallbackReplay(reason = '') {
    stopReplayEngine();
    state.generation += 1;
    state.engine = 'fallback';
    state.delaySeconds = Math.min(Number(ui.delay.value), 3);
    if (Number(ui.delay.value) !== state.delaySeconds) {
      ui.delay.value = String(state.delaySeconds);
      updateDelayText();
    }
    const generation = state.generation;
    const width = 426;
    const height = 240;
    const fps = 15;
    ui.processingCanvas.width = width;
    ui.processingCanvas.height = height;
    ui.delayedCanvas.width = width;
    ui.delayedCanvas.height = height;
    ui.delayedVideo.hidden = true;
    ui.delayedCanvas.hidden = false;
    ui.engineBadge.textContent = 'Compatibility replay';
    const size = Math.max(1, state.delaySeconds * fps);
    state.fallbackFrames = Array.from({ length: size }, () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    });
    state.frameTimer = setInterval(() => {
      if (!state.running || generation !== state.generation) return;
      drawContained(ui.live, ui.processingCanvas);
      const frame = state.fallbackFrames[state.fallbackWrite];
      frame.getContext('2d', { alpha: false }).drawImage(ui.processingCanvas, 0, 0);
      state.fallbackWrite = (state.fallbackWrite + 1) % size;
      state.fallbackSeen += 1;
      const have = Math.min(state.fallbackSeen, size);
      ui.bufferStatus.textContent = plural(Math.floor(have / fps), 'second');
      if (state.fallbackSeen <= size) return;
      ui.delayedCanvas.getContext('2d', { alpha: false }).drawImage(state.fallbackFrames[state.fallbackWrite], 0, 0);
      hideViewerMessage();
      ui.replayStatus.textContent = 'Playing';
    }, 1000 / fps);
    showViewerMessage('Compatibility mode', `This browser supports a maximum ${state.delaySeconds}-second low-resolution delay.`);
    if (reason) showToast(`${reason} Using a ${state.delaySeconds}-second compatibility delay instead.`, 7000);
  }

  function startReplayEngine() {
    state.delaySeconds = Number(ui.delay.value);
    const replay = parseResolution(ui.replayResolution.value);
    ui.processingCanvas.width = replay.width;
    ui.processingCanvas.height = replay.height;
    state.replayFps = Math.min(Number(ui.captureFps.value), 30);
    const mimeType = compatibleMimeTypes()[0];
    if (mimeType && ui.processingCanvas.captureStream) startCompressedReplay(mimeType);
    else startFallbackReplay('Compressed replay is unavailable in this browser.');
  }

  async function startCamera() {
    await stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) {
      showViewerMessage('Camera unavailable', 'Use a current version of Safari, Chrome, or Edge over HTTPS.');
      return;
    }
    const capture = parseResolution(ui.captureResolution.value);
    const selectedDevice = ui.camera.value;
    const video = {
      width: { ideal: capture.width }, height: { ideal: capture.height },
      frameRate: { ideal: Number(ui.captureFps.value), max: Number(ui.captureFps.value) }
    };
    if (selectedDevice) video.deviceId = { exact: selectedDevice };
    else video.facingMode = { ideal: state.facingMode };
    showViewerMessage('Starting camera', 'Approve camera access if your browser asks.');
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
      ui.live.srcObject = state.stream;
      await ui.live.play();
      await new Promise(resolve => {
        if (ui.live.videoWidth) resolve();
        else ui.live.addEventListener('loadedmetadata', resolve, { once: true });
      });
      state.running = true;
      state.generation += 1;
      const track = state.stream.getVideoTracks()[0];
      const settings = track.getSettings();
      await enumerateCameras(settings.deviceId || selectedDevice);
      ui.actualBadge.textContent = `${settings.width || ui.live.videoWidth}×${settings.height || ui.live.videoHeight} @ ${Math.round(settings.frameRate || Number(ui.captureFps.value))} FPS`;
      ui.cameraStatus.textContent = track.label || 'Active';
      setRunningUi(true);
      applyMirror();
      startReplayEngine();
      requestWakeLock();
      localStorage.setItem('replay-preferences', JSON.stringify({
        delay: ui.delay.value, captureResolution: ui.captureResolution.value,
        replayResolution: ui.replayResolution.value, captureFps: ui.captureFps.value
      }));
    } catch (error) {
      console.error('Camera start failed', error);
      const messages = {
        NotAllowedError: 'Camera permission was denied. Allow camera access in the browser settings and try again.',
        NotFoundError: 'No camera was found on this device.',
        NotReadableError: 'Another app may be using the camera. Close it and try again.',
        OverconstrainedError: 'The selected camera setting is unsupported. Choose 720p at 30 FPS.',
        SecurityError: 'Camera access requires a secure HTTPS page.'
      };
      showViewerMessage('Could not start camera', messages[error.name] || 'Check camera permission and try again.');
      showToast(messages[error.name] || 'The camera could not start.');
      setRunningUi(false);
    }
  }

  async function stopCamera() {
    stopReplayEngine();
    if (state.stream) state.stream.getTracks().forEach(track => track.stop());
    state.stream = null;
    state.running = false;
    ui.live.srcObject = null;
    setRunningUi(false);
    ui.cameraStatus.textContent = 'Stopped';
    ui.replayStatus.textContent = 'Waiting';
    ui.bufferStatus.textContent = '0 seconds';
    ui.actualBadge.textContent = 'No camera';
    ui.engineBadge.textContent = 'On-device';
    showViewerMessage('Camera is stopped', 'Choose a delay and start the camera.');
    await releaseWakeLock();
  }

  function applyMirror() {
    ui.delayedVideo.classList.toggle('mirrored', state.mirrored);
    ui.delayedCanvas.classList.toggle('mirrored', state.mirrored);
    ui.mirror.textContent = `Mirror: ${state.mirrored ? 'on' : 'off'}`;
    ui.mirror.setAttribute('aria-pressed', String(state.mirrored));
  }

  async function switchCamera() {
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    ui.camera.value = '';
    await startCamera();
  }

  function pickClipMime() {
    if (!window.MediaRecorder?.isTypeSupported) return '';
    return ['video/mp4;codecs="avc1.42E01E"', 'video/webm;codecs=vp8', 'video/webm']
      .find(type => MediaRecorder.isTypeSupported(type)) || '';
  }

  function startClipFramePump(generation) {
    const source = state.engine === 'compressed' ? ui.delayedVideo : ui.delayedCanvas;
    const draw = () => {
      if (generation !== state.generation) return;
      drawContained(source, ui.clipCanvas);
      state.clipFrame = requestAnimationFrame(draw);
    };
    state.clipFrame = requestAnimationFrame(draw);
  }

  async function recordClip() {
    if (!state.running || !window.MediaRecorder || !ui.clipCanvas.captureStream) {
      showToast('Clip recording is unavailable in this browser.');
      return;
    }
    const seconds = Number(ui.clipLength.value);
    const replay = parseResolution(ui.replayResolution.value);
    ui.clipCanvas.width = state.engine === 'fallback' ? 426 : replay.width;
    ui.clipCanvas.height = state.engine === 'fallback' ? 240 : replay.height;
    const mimeType = pickClipMime();
    const chunks = [];
    let clipRecorder;
    try {
      clipRecorder = mimeType
        ? new MediaRecorder(ui.clipCanvas.captureStream(state.replayFps), { mimeType, videoBitsPerSecond: 2_000_000 })
        : new MediaRecorder(ui.clipCanvas.captureStream(state.replayFps));
    } catch (error) {
      console.error('Clip recorder failed', error);
      showToast('This browser could not start the clip recorder.');
      return;
    }
    const generation = state.generation;
    clipRecorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
    const completed = new Promise(resolve => {
      clipRecorder.onstop = () => resolve(new Blob(chunks, { type: clipRecorder.mimeType || mimeType || 'video/webm' }));
    });
    startClipFramePump(generation);
    clipRecorder.start(1000);
    ui.recordClip.disabled = true;
    for (let remaining = seconds; remaining > 0; remaining -= 1) {
      ui.recordClip.textContent = `Recording… ${remaining}s`;
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!state.running || generation !== state.generation) break;
    }
    if (clipRecorder.state !== 'inactive') clipRecorder.stop();
    cancelAnimationFrame(state.clipFrame);
    state.clipFrame = null;
    const blob = await completed;
    ui.recordClip.disabled = !state.running;
    ui.recordClip.textContent = `Record next ${plural(seconds, 'second')}`;
    if (!blob.size) { showToast('The recorded clip was empty. Please try again.'); return; }
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = URL.createObjectURL(blob);
    const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    ui.download.href = state.downloadUrl;
    ui.download.download = `replay-${timestamp}.${extension}`;
    ui.download.hidden = false;
    showToast('Clip is ready to download.');
  }

  function restorePreferences() {
    try {
      const saved = JSON.parse(localStorage.getItem('replay-preferences') || '{}');
      if (saved.delay) ui.delay.value = saved.delay;
      if (saved.captureResolution) ui.captureResolution.value = saved.captureResolution;
      if (saved.replayResolution) ui.replayResolution.value = saved.replayResolution;
      if (saved.captureFps) ui.captureFps.value = saved.captureFps;
    } catch {}
    updateDelayText();
  }

  ui.start.addEventListener('click', startCamera);
  ui.stop.addEventListener('click', stopCamera);
  ui.flip.addEventListener('click', switchCamera);
  ui.mirror.addEventListener('click', () => { state.mirrored = !state.mirrored; applyMirror(); });
  ui.delay.addEventListener('input', () => { updateDelayText(); ui.restartNote.hidden = !state.running; });
  ui.delay.addEventListener('change', () => {
    ui.restartNote.hidden = true;
    if (state.running) { stopReplayEngine(); state.generation += 1; startReplayEngine(); }
  });
  ui.clipLength.addEventListener('change', () => { ui.recordClip.textContent = `Record next ${plural(Number(ui.clipLength.value), 'second')}`; });
  ui.recordClip.addEventListener('click', recordClip);
  ui.camera.addEventListener('change', () => { if (state.running) startCamera(); });
  ui.fullscreen.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await ui.viewer.requestFullscreen();
    } catch { showToast('Full screen is unavailable in this browser.'); }
  });
  document.addEventListener('fullscreenchange', () => { ui.fullscreen.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'; });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.running && !state.wakeLock) requestWakeLock(); });
  window.addEventListener('pagehide', stopCamera);
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    state.deferredInstall = event;
    ui.install.hidden = false;
  });
  ui.install.addEventListener('click', async () => {
    if (!state.deferredInstall) return;
    state.deferredInstall.prompt();
    await state.deferredInstall.userChoice;
    state.deferredInstall = null;
    ui.install.hidden = true;
  });

  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Service worker unavailable', error)));
  restorePreferences();
  enumerateCameras();
})();

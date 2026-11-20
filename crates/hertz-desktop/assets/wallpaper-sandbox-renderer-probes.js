// SPDX-License-Identifier: MIT
// Paired-binary workloads only. Ports come from held parent loopback listeners.
// Page results are diagnostics; the parent independently checks policy/transport/exit.
(mode, targets) => {
  'use strict';
  const send = value => window.chrome.webview.postMessage(JSON.stringify(value));
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (condition, label) => { if (!condition) throw new Error(label); };
  const timed = async (promise, ms = 1500) => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe timeout')), ms);
      })]);
    } finally { clearTimeout(timer); }
  };
  const finish = receipt => send({ type: 'rendererCompleted', marker: 'hertz-g3s-renderer-v1', receipt });
  send({ type: 'probeStarted', marker: 'hertz-g3s-adversarial-v1', mode, allocatedBytes: 0 });

  async function network() {
    check(targets && ['tcp4', 'tcp6', 'udp4'].every(key => Number.isInteger(targets[key])
      && targets[key] > 0 && targets[key] <= 65535), 'invalid owned loopback ports');
    const http4 = `http://127.0.0.1:${targets.tcp4}`;
    const https4 = `https://127.0.0.1:${targets.tcp4}`;
    const http6 = `http://[::1]:${targets.tcp6}`;
    const https6 = `https://[::1]:${targets.tcp6}`;
    const attempts = [], violations = [];
    let rtcPhase = 'notStarted';
    const violation = event => {
      if (violations.length < 32) violations.push({ directive: event.effectiveDirective.slice(0, 64),
        blocked: event.blockedURI.slice(0, 96) });
    };
    document.addEventListener('securitypolicyviolation', violation);
    const attempt = async (id, operation, cleanup = () => {}, timeoutMs = 400) => {
      const before = performance.now();
      let outcome;
      try { outcome = await timed(Promise.resolve().then(operation), timeoutMs) || 'fulfilled'; }
      catch (error) { outcome = error.message === 'probe timeout' ? 'timedOut' : 'rejected'; }
      finally { cleanup(); }
      attempts.push({ id, outcome, elapsedMs: Math.round(performance.now() - before) });
      // Allow CSP/native callbacks to settle before the next fixed operation.
      await delay(40);
    };
    const request = (id, url, options = {}) => {
      const controller = new AbortController();
      return attempt(id, () => fetch(url, { credentials: 'omit', cache: 'no-store',
        referrerPolicy: 'no-referrer', ...options, signal: controller.signal }).then(response => {
        response.body?.cancel().catch(() => {});
      }), () => controller.abort());
    };
    const socket = (id, url) => {
      let ws;
      return attempt(id, () => new Promise((resolve, reject) => {
        ws = new WebSocket(url);
        ws.onopen = () => resolve('fulfilled'); ws.onerror = () => reject(new Error('socket rejected'));
      }), () => { if (ws) { ws.onopen = ws.onerror = null; ws.close(); } });
    };
    const element = (id, tag, url) => {
      let node;
      return attempt(id, () => new Promise((resolve, reject) => {
        node = document.createElement(tag);
        // A blocked iframe can still fire load for its empty error document.
        node.onload = () => resolve(tag === 'iframe' ? 'dispatched' : 'fulfilled');
        node.onerror = () => reject(new Error('element rejected'));
        node.src = url; document.body.append(node);
      }), () => node?.remove());
    };
    try {
      for (const [id, url] of [['http4', http4], ['https4', https4], ['http6', http6], ['https6', https6]])
        await request(id, `${url}/probe`);
      let xhr;
      await attempt('xhr', () => new Promise((resolve, reject) => {
        xhr = new XMLHttpRequest(); xhr.open('GET', `${http4}/xhr`);
        xhr.onload = () => resolve('fulfilled'); xhr.onerror = () => reject(new Error('xhr rejected')); xhr.send();
      }), () => xhr?.abort());
      await attempt('beacon', () => navigator.sendBeacon(`${http4}/beacon`, 'probe') ? 'dispatched' : 'rejected');
      let events;
      await attempt('eventSource', () => new Promise((resolve, reject) => {
        events = new EventSource(`${http4}/events`);
        events.onopen = () => resolve('fulfilled'); events.onerror = () => reject(new Error('events rejected'));
      }), () => events?.close());
      await socket('webSocket', `ws://127.0.0.1:${targets.tcp4}/ws`);
      await socket('secureWebSocket', `wss://127.0.0.1:${targets.tcp4}/ws`);
      let transport;
      await attempt('webTransport', () => {
        if (!globalThis.WebTransport) return 'unavailable';
        transport = new WebTransport(`https://127.0.0.1:${targets.udp4}/transport`);
        transport.closed.catch(() => {});
        return transport.ready.then(() => 'fulfilled');
      }, () => transport?.close());
      let peer, rtcActive = false;
      await attempt('rtcStun', async () => {
        if (!globalThis.RTCPeerConnection) { rtcPhase = 'unavailable'; return 'unavailable'; }
        rtcActive = true;
        rtcPhase = 'createPeer';
        peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${targets.udp4}` }],
          iceCandidatePoolSize: 0 });
        peer.createDataChannel('fixed-probe');
        rtcPhase = 'createOffer';
        const offer = await peer.createOffer();
        if (!rtcActive) return 'timedOut';
        rtcPhase = 'setLocalDescription';
        await peer.setLocalDescription(offer);
        if (!rtcActive) return 'timedOut';
        rtcPhase = 'gathering';
        await delay(250);
        if (!rtcActive) return 'timedOut';
        rtcPhase = 'completed';
        return 'dispatched'; // A local SDP is not proof of network denial or STUN success.
      // This includes certificate/utility startup plus a 250ms observation
      // window. It is not the product's independent native stop deadline.
      }, () => { rtcActive = false; peer?.close(); }, 1500);
      let worker, blobUrl;
      const workerAttempt = id => attempt(id, () => new Promise((resolve, reject) => {
        if (id === 'blobWorker') blobUrl = URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }));
        worker = new Worker(blobUrl || `${location.origin}/files/probe.js`);
        worker.onmessage = () => resolve('fulfilled'); worker.onerror = () => reject(new Error('worker rejected'));
      }), () => { worker?.terminate(); worker = null; if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = null; });
      await workerAttempt('worker'); await workerAttempt('blobWorker');
      let shared;
      await attempt('sharedWorker', () => {
        if (!globalThis.SharedWorker) return 'unavailable';
        return new Promise((resolve, reject) => {
          shared = new SharedWorker(`${location.origin}/files/probe.js`);
          shared.onerror = () => reject(new Error('shared worker rejected'));
          shared.port.onmessage = () => resolve('fulfilled'); shared.port.start();
        });
      }, () => shared?.port.close());
      await attempt('serviceWorker', () => {
        if (!navigator.serviceWorker) return 'unavailable';
        return navigator.serviceWorker.register(`${location.origin}/files/probe.js`)
          .then(async registration => { await registration.unregister(); return 'fulfilled'; });
      });
      await element('image', 'img', `${http4}/image`);
      await element('iframe', 'iframe', `${http4}/frame`);
      let form;
      await attempt('form', () => {
        form = document.createElement('form'); form.action = `${http4}/form`; form.method = 'POST';
        document.body.append(form); form.submit(); return 'dispatched';
      }, () => form?.remove());
      for (const [id, rel, href] of [['dnsPrefetch', 'dns-prefetch', '//localhost'], ['preconnect', 'preconnect', http4]]) {
        let link;
        await attempt(id, async () => {
          link = document.createElement('link'); link.rel = rel; link.href = href; document.head.append(link);
          await delay(250); return 'dispatched';
        }, () => link?.remove());
      }
      // Initial request only: blocked initial fetch cannot qualify a redirect chain.
      await request('redirect', `${http4}/redirect`, { redirect: 'follow' });
      let downloadUrl, anchor;
      await attempt('download', async () => {
        downloadUrl = URL.createObjectURL(new Blob(['fixed probe'], { type: 'text/plain' }));
        anchor = document.createElement('a'); anchor.href = downloadUrl; anchor.download = 'fixed-probe.txt';
        document.body.append(anchor); anchor.click(); await delay(250); return 'dispatched';
      }, () => { anchor?.remove(); if (downloadUrl) URL.revokeObjectURL(downloadUrl); });
      await attempt('popup', () => { const popup = window.open(`${http4}/popup`); popup?.close(); return 'dispatched'; });
      await attempt('externalUri', async () => { location.href = 'hertz-g3s-probe:denied'; await delay(150); return 'dispatched'; });
      await attempt('navigation', async () => { location.href = `${http4}/navigation`; await delay(150); return 'dispatched'; });
      await delay(100);
      finish({ kind: 'network', attempts, violations, rtcPhase });
    } finally { document.removeEventListener('securitypolicyviolation', violation); }
  }

  async function graphics() {
    const receipt = { kind: 'graphics', canvasRounds: 0, webGlRounds: 0,
      imageDecodeRounds: 0, videoDecodeRounds: 0, failure: null };
    const canvas = (size) => { const c = document.createElement('canvas'); c.width = c.height = size; return c; };
    try {
      check(globalThis.ImageDecoder && globalThis.VideoEncoder && globalThis.VideoDecoder, 'required codec API unavailable');
      const config = { codec: 'vp8', width: 256, height: 256, bitrate: 200000, framerate: 30,
        latencyMode: 'realtime', hardwareAcceleration: 'prefer-software' };
      check((await timed(VideoEncoder.isConfigSupported(config))).supported, 'VP8 encoder unavailable');
      check((await timed(VideoDecoder.isConfigSupported({ codec: 'vp8' }))).supported, 'VP8 decoder unavailable');
      for (let round = 0; round < 8; round++) {
        const c = canvas(1024), g = canvas(1024), video = canvas(256);
        let bitmap, imageDecoder, image, gl, texture, framebuffer, encoder, decoder, sourceFrame;
        try {
          const ctx = c.getContext('2d', { willReadFrequently: true });
          check(ctx, '2D context unavailable');
          ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, c.width, c.height);
          // A late bitmap result is closed even if its deadline has already failed.
          let bitmapAccepted = true;
          try { bitmap = await timed(createImageBitmap(c).then(value => {
            if (!bitmapAccepted) value.close(); return value;
          })); } finally { bitmapAccepted = false; }
          ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(bitmap, 0, 0);
          check(ctx.getImageData(10, 10, 1, 1).data[0] === 255, 'Canvas pixel mismatch');
          bitmap.close(); bitmap = null; receipt.canvasRounds++;
          const blob = await timed(new Promise(resolve => c.toBlob(resolve, 'image/png')));
          check(blob && blob.size <= 1024 * 1024, 'PNG output bound');
          imageDecoder = new ImageDecoder({ data: await timed(blob.arrayBuffer()), type: 'image/png' });
          let imageAccepted = true;
          try { image = (await timed(imageDecoder.decode().then(value => {
            if (!imageAccepted) value.image.close(); return value;
          }))).image; } finally { imageAccepted = false; }
          check(image.displayWidth === 1024 && image.displayHeight === 1024, 'PNG decode geometry');
          ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(image, 0, 0);
          check(ctx.getImageData(10, 10, 1, 1).data[0] === 255, 'PNG decoded pixel mismatch');
          image.close(); image = null; imageDecoder.close(); imageDecoder = null; receipt.imageDecodeRounds++;

          gl = g.getContext('webgl', { antialias: false }); check(gl, 'WebGL unavailable');
          const loss = gl.getExtension('WEBGL_lose_context'); check(loss, 'context retirement unavailable');
          texture = gl.createTexture(); framebuffer = gl.createFramebuffer(); check(texture && framebuffer, 'GL allocation failed');
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1024, 1024, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
          check(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, 'GL framebuffer incomplete');
          gl.clearColor(0, 1, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
          const pixel = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          check(pixel[1] === 255 && gl.getError() === gl.NO_ERROR, 'GL pixel mismatch');
          gl.deleteFramebuffer(framebuffer); framebuffer = null; gl.deleteTexture(texture); texture = null;
          const lost = new Promise(resolve => g.addEventListener('webglcontextlost', resolve, { once: true }));
          loss.loseContext(); await timed(lost); gl = null; receipt.webGlRounds++;

          const vx = video.getContext('2d'); check(vx, 'video source context unavailable');
          vx.fillStyle = '#ff0000'; vx.fillRect(0, 0, 256, 256);
          let chunk, codecError, decodedFrames = 0;
          encoder = new VideoEncoder({ output(value) { chunk = value; }, error(error) { codecError = error; } });
          encoder.configure(config); sourceFrame = new VideoFrame(video, { timestamp: round * 33333 });
          encoder.encode(sourceFrame, { keyFrame: true }); sourceFrame.close(); sourceFrame = null;
          await timed(encoder.flush()); check(!codecError && chunk && chunk.byteLength <= 1024 * 1024, 'VP8 encode failed');
          encoder.close(); encoder = null;
          decoder = new VideoDecoder({ output(frame) {
            try {
              vx.clearRect(0, 0, 256, 256); vx.drawImage(frame, 0, 0);
              const p = vx.getImageData(10, 10, 1, 1).data;
              if (frame.displayWidth === 256 && frame.displayHeight === 256 && p[0] > 220 && p[1] < 30) decodedFrames++;
            } finally { frame.close(); }
          }, error(error) { codecError = error; } });
          decoder.configure({ codec: 'vp8', hardwareAcceleration: 'prefer-software' });
          decoder.decode(chunk); await timed(decoder.flush()); check(!codecError && decodedFrames === 1, 'VP8 decoded pixel mismatch');
          decoder.close(); decoder = null; receipt.videoDecodeRounds++;
        } finally {
          bitmap?.close(); image?.close(); imageDecoder?.close(); sourceFrame?.close();
          if (encoder && encoder.state !== 'closed') encoder.close();
          if (decoder && decoder.state !== 'closed') decoder.close();
          if (gl) { gl.deleteFramebuffer(framebuffer); gl.deleteTexture(texture); gl.getExtension('WEBGL_lose_context')?.loseContext(); }
          for (const surface of [c, g, video]) surface.width = surface.height = 0;
        }
        await delay(20);
      }
    } catch (error) { receipt.failure = String(error.message || 'graphics failure').slice(0, 128); }
    finish(receipt);
  }
  if (mode === 'rendererNetwork') return network();
  if (mode === 'graphicsPressure') return graphics();
  throw new Error('Unknown fixed renderer workload');
}

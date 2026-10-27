// SPDX-License-Identifier: MIT
(async () => {
  const canvas = document.querySelector('canvas');
  const host = SpaceStagePure.create(canvas, { qualityMode: 'medium', deviceTier: 'high' });
  window.phoenixPreview = host;
  await host.select('phoenix-vortex');
  const definition = SpaceStagePure.catalog().find(scene => scene.id === 'phoenix-vortex');
  const baseline = definition.camera.baseline || definition.camera;
  const camera = SpaceCamera;
  camera.setBaseline({ ...baseline, look: baseline.lookAt || [0, 1.1, 0] });
  camera.setCinema(false, 0); camera.snap();
  const resize = () => { host.resize(innerWidth, innerHeight); host.setRig(camera.pose()); };
  resize(); addEventListener('resize', resize);

  let playing = true, last = 0, busy = false, gesture = null, clickSerial = 0, lastClick = -Infinity, clickTimer = 0;
  const pointer = { active: false, down: false, dragging: false, x: 0, y: 0, click: { serial: 0, x: 0, y: 0 } };
  const play = document.querySelector('#play');
  play.onclick = () => { playing = !playing; play.textContent = playing ? '暂停' : '继续'; };
  document.querySelector('#restart').onclick = async () => {
    clearTimeout(clickTimer);
    busy = true;
    try { await host.select('phoenix-vortex'); resize(); }
    finally { busy = false; }
  };
  const resetCamera = () => { clearTimeout(clickTimer); camera.clearInput(); camera.recenter(); };
  document.querySelector('#reset-camera').onclick = resetCamera;
  canvas.addEventListener('dblclick', resetCamera);
  const locate = event => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) / rect.width * 2 - 1;
    pointer.y = 1 - (event.clientY - rect.top) / rect.height * 2;
    pointer.active = true;
  };
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || gesture) return;
    event.preventDefault(); locate(event);
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, time: performance.now() };
    pointer.down = true; pointer.dragging = false;
    canvas.setPointerCapture(event.pointerId); camera.setRotating(true); canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', event => {
    locate(event);
    if (!gesture || gesture.id !== event.pointerId) return;
    const now = performance.now();
    if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 5) {
      clearTimeout(clickTimer);
      pointer.dragging = true; pointer.down = false;
    }
    if (pointer.dragging) camera.spinDrag(event.clientX - gesture.x, event.clientY - gesture.y, Math.max(1 / 120, Math.min(.08, (now - gesture.time) / 1000)));
    gesture.x = event.clientX; gesture.y = event.clientY; gesture.time = now;
  });
  function endGesture(event) {
    if (!gesture || gesture.id !== event.pointerId) return;
    if (event.type === 'pointerup' && !pointer.dragging && performance.now() - lastClick > 250) {
      lastClick = performance.now();
      // Give a double-click time to reset the camera without starting the rite.
      const { x, y } = pointer;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => { pointer.click = { serial: ++clickSerial, x, y }; }, 300);
    }
    gesture = null; pointer.down = false; pointer.dragging = false;
    camera.setRotating(false); canvas.classList.remove('dragging');
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, endGesture);
  canvas.addEventListener('pointerleave', () => { if (!gesture) pointer.active = false; });
  addEventListener('blur', () => {
    clearTimeout(clickTimer);
    if (gesture) endGesture({ type: 'pointercancel', pointerId: gesture.id });
    pointer.active = false;
  });
  canvas.addEventListener('wheel', event => { event.preventDefault(); camera.wheel(event.deltaY); }, { passive: false });

  const names = { flight: '神凤展翼', swarm: '化作凤群', gather: '汇聚凝卵', egg: '烈焰淬炼', rebirth: '涅槃重生' };
  function frame(now) {
    const dt = last ? Math.min(.05, (now - last) / 1000) : 0; last = now;
    // Camera input stays live while the performance is paused.
    camera.tick(dt * 1000, { playing: false });
    host.setRig(camera.pose());
    if (!busy) {
      host.frame({ now, dt: playing ? dt : 0, dynamicDt: playing ? dt : 0, time: now / 1000, sceneTime: now / 1000, playing, pointer, bands: { bass: .12, mid: .1, treble: .08 } });
      const state = host.stats().sceneStats?.primary;
      if (state) {
        const time = state.timeline % 36;
        document.querySelector('progress').value = time;
        document.querySelector('#time').textContent = String(Math.floor(time)).padStart(2, '0') + ' / 36s';
        document.querySelector('#phase').textContent = time >= 6 && time < 17 ? '羽化凤群' : names[state.phase] || state.phase;
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})().catch(error => { document.querySelector('#error').textContent = error.message; });

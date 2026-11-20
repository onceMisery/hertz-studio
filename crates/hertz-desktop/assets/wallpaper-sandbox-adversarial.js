// SPDX-License-Identifier: MIT
// Fixed qualification workloads, invoked only by the paired native probe.
// Limits are intentional: no arbitrary source, external host or unbounded loop.
(mode) => {
  'use strict';
  const send = (value) => window.chrome.webview.postMessage(JSON.stringify(value));
  const started = (allocatedBytes = 0) => send({ type: 'probeStarted',
    marker: 'hertz-g3s-adversarial-v1', mode, allocatedBytes });
  if (mode === 'busySuspend') {
    setTimeout(() => {
      started();
      const end = performance.now() + 8000;
      let value = 1;
      while (performance.now() < end) value = Math.imul(value + 1, 1664525);
      window.__hertzBoundedProbeValue = value;
    }, 0);
  } else if (mode === 'boundedMemory') {
    const blocks = [];
    for (let index = 0; index < 16; index++) {
      const block = new Uint8Array(4 * 1024 * 1024);
      // Touch every page so a mere virtual reservation is not counted as pressure.
      for (let offset = 0; offset < block.length; offset += 4096) block[offset] = 0x5a;
      blocks.push(block);
    }
    window.__hertzBoundedProbeMemory = blocks;
    started(64 * 1024 * 1024);
  } else if (mode === 'memoryLimit') {
    const blocks = window.__hertzBoundedProbeMemory = [];
    started();
    // The native whole-Job cap remains 512 MiB. This fixed maximum attempts to
    // cross it without relying on page self-report as enforcement evidence.
    const allocate = () => {
      if (blocks.length >= 40) return;
      try {
        const block = new Uint8Array(16 * 1024 * 1024);
        for (let offset = 0; offset < block.length; offset += 4096) block[offset] = 0x5a;
        blocks.push(block);
        setTimeout(allocate, 20);
      } catch (_) {
        // JS allocation refusal alone is not a native Job-limit receipt.
        window.__hertzBoundedProbeAllocationStopped = true;
      }
    };
    setTimeout(allocate, 50);
  } else if (mode === 'messageFlood') {
    started();
    for (let index = 0; index < 192; index++) {
      send({ type: 'probeReady', width: innerWidth, height: innerHeight,
        marker: 'hertz-g3s-fixed-probe-v1' });
    }
  } else {
    throw new Error('Unknown fixed qualification workload');
  }
}

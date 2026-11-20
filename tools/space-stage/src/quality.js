export const PROFILES = Object.freeze({
  low: Object.freeze({ mode: 'low', fps: 30, density: 0.4, dprCap: 0.85, pixelBudget: 1000000, drawCalls: 40, particles: 12000, triangles: 80000, memoryBytes: 64 * 1048576, post: false }),
  medium: Object.freeze({ mode: 'medium', fps: 60, density: 0.7, dprCap: 1, pixelBudget: 2100000, drawCalls: 80, particles: 30000, triangles: 200000, memoryBytes: 128 * 1048576, post: true }),
  high: Object.freeze({ mode: 'high', fps: 60, density: 1, dprCap: 1.25, pixelBudget: 3300000, drawCalls: 120, particles: 50000, triangles: 400000, memoryBytes: 192 * 1048576, post: true }),
});
const ORDER = ['low', 'medium', 'high'];
export function normalizeQualityMode(mode) { return ['auto', ...ORDER].includes(mode) ? mode : 'auto'; }
export function createQuality(mode = 'auto', tier = 1) {
  const tierIndex = value => typeof value === 'string' && ORDER.includes(value) ? ORDER.indexOf(value) : Number.isFinite(Number(value)) ? Math.max(0, Math.min(2, Math.floor(Number(value)))) : 1;
  let ceiling = tierIndex(tier);
  let chosen = normalizeQualityMode(mode), effective = 0, reason = '', started = null, windowStart = 0, last = null, intervals = [], pressure = 0;
  function reset(now = null) {
    effective = Math.min(ceiling, chosen === 'auto' ? 1 : ORDER.indexOf(chosen));
    reason = effective < (chosen === 'auto' ? 1 : ORDER.indexOf(chosen)) ? 'device-ceiling' : '';
    started = now; windowStart = now || 0; last = null; intervals = []; pressure = 0;
  }
  reset();
  return {
    profile: () => PROFILES[ORDER[effective]],
    status: () => ({ qualityMode: chosen, effectiveQuality: ORDER[effective], qualityReason: reason }),
    setMode(value) { chosen = normalizeQualityMode(value); reset(); },
    setDeviceTier(value) {
      ceiling = Math.min(ceiling, tierIndex(value));
      if (effective <= ceiling) return false;
      effective = ceiling; reason = 'device-ceiling'; pressure = 0; return true;
    },
    warmup(now) { started = now; windowStart = now || 0; intervals = []; last = null; pressure = 0; },
    dpr(width, height, device = 1) { const q = PROFILES[ORDER[effective]]; return Math.min(device, q.dprCap, Math.sqrt(q.pixelBudget / Math.max(1, width * height))); },
    sample(now, counts, cpuMs, targetFps) {
      if (started === null) { started = now; windowStart = now; }
      if (last !== null && now > last) intervals.push(now - last);
      last = now;
      if (now - started < 10000 || now - windowStart < 2000) return false;
      const q = PROFILES[ORDER[effective]];
      // A host may deliberately submit fewer frames than the quality profile.
      // Judge pressure against that budget, not against frames it never requested.
      const fps = Number.isFinite(targetFps) && targetFps > 0 ? Math.min(q.fps, targetFps) : q.fps;
      if (typeof counts === 'function') counts = counts();
      const sorted = intervals.slice().sort((a,b) => a-b);
      const p95 = sorted[Math.floor(sorted.length * .95)] || 0;
      const over = sorted.length >= 10 && (p95 > 1000 / fps * 1.4 || cpuMs > 1000 / fps * .8 || counts.drawCalls > q.drawCalls || counts.points > q.particles || counts.triangles > q.triangles || counts.estimatedBytes > q.memoryBytes);
      pressure = over ? pressure + 1 : 0;
      windowStart = now; intervals = [];
      if (pressure >= 3 && effective > 0) { effective--; reason = 'sustained-frame-or-resource-pressure'; pressure = 0; return true; }
      return false;
    },
  };
}

// SPDX-License-Identifier: MIT
// Pure timeline track evaluation over compiler-validated keys.
const EASINGS = new Set(['linear', 'easeInOut', 'step']);

export function validateTrack(track, numericSlots) {
  if (!track || !Number.isSafeInteger(track.targetSlot) || track.targetSlot < 0
    || track.targetSlot >= numericSlots.length) return 'composition-track-target-invalid';
  if (!Array.isArray(track.keys) || !track.keys.length || track.keys.length > 4096) return 'composition-track-keys-invalid';
  const slot = numericSlots[track.targetSlot];
  let previous = -Infinity;
  for (const key of track.keys) {
    if (!key || !Number.isFinite(key.timeSeconds) || key.timeSeconds <= previous
      || !Number.isFinite(key.value) || key.value < slot.min || key.value > slot.max
      || !EASINGS.has(key.easing)) return 'composition-track-keys-invalid';
    previous = key.timeSeconds;
  }
  return null;
}

export function evaluateTrack(keys, time) {
  if (time <= keys[0].timeSeconds) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.timeSeconds) return last.value;
  let low = 0, high = keys.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (keys[middle].timeSeconds <= time) low = middle;
    else high = middle;
  }
  const start = keys[low], end = keys[high];
  if (start.easing === 'step') return start.value;
  let ratio = (time - start.timeSeconds) / (end.timeSeconds - start.timeSeconds);
  if (start.easing === 'easeInOut') ratio = ratio * ratio * (3 - 2 * ratio);
  return start.value + (end.value - start.value) * ratio;
}

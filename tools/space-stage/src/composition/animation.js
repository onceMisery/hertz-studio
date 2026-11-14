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

export const BINDING_MODES = new Set(['add', 'multiply', 'replace']);

export function validateBinding(binding, numericSlots, inputCount) {
  if (!binding || typeof binding.id !== 'string' || !binding.id) return 'composition-binding-invalid';
  if (!Number.isSafeInteger(binding.targetSlot) || binding.targetSlot < 0
    || binding.targetSlot >= numericSlots.length) return 'composition-binding-target-invalid';
  if (!BINDING_MODES.has(binding.mode)) return 'composition-binding-mode-invalid';
  if (!Array.isArray(binding.parameters) || binding.parameters.length > 32) return 'composition-binding-invalid';
  for (const pair of binding.parameters) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !Number.isFinite(pair[1]))
      return 'composition-binding-invalid';
  }
  if (!Array.isArray(binding.program) || !binding.program.length || binding.program.length > 32
    || !Number.isSafeInteger(binding.maxStack) || binding.maxStack < 1 || binding.maxStack > 8)
    return 'composition-binding-program-invalid';
  for (const instruction of binding.program) {
    if (!instruction || !Number.isSafeInteger(instruction.opcode) || instruction.opcode < 0 || instruction.opcode > 10
      || !Number.isSafeInteger(instruction.index) || instruction.index < 0
      || !Array.isArray(instruction.operands) || instruction.operands.length !== 4
      || !instruction.operands.every(Number.isFinite)) return 'composition-binding-program-invalid';
    if (instruction.opcode === 0 && instruction.index >= inputCount) return 'composition-binding-program-invalid';
    if (instruction.opcode === 1 && instruction.index >= binding.parameters.length) return 'composition-binding-program-invalid';
    if (instruction.opcode === 8 && instruction.operands[0] > instruction.operands[1]) return 'composition-binding-program-invalid';
    if (instruction.opcode === 9 && instruction.operands[0] === instruction.operands[1]) return 'composition-binding-program-invalid';
    if (instruction.opcode === 10 && instruction.operands[0] >= instruction.operands[1]) return 'composition-binding-program-invalid';
  }
  return null;
}

/** Executes one validated stack program into the caller-owned scratch stack. */
export function evaluateBinding(binding, inputs, parameters, stack) {
  let depth = 0;
  for (const { opcode, index, operands } of binding.program) {
    let value;
    switch (opcode) {
      case 0: value = inputs[index]; stack[depth++] = Number.isFinite(value) ? value : 0; continue;
      case 1: value = parameters[index]; stack[depth++] = Number.isFinite(value) ? value : 0; continue;
      case 2: stack[depth++] = operands[0]; continue;
      case 3: if (depth < 2) return null; depth--; stack[depth - 1] += stack[depth]; break;
      case 4: if (depth < 2) return null; depth--; stack[depth - 1] *= stack[depth]; break;
      case 5: if (depth < 1) return null; stack[depth - 1] = Math.sin(stack[depth - 1]); break;
      case 6: if (depth < 1) return null; stack[depth - 1] = Math.cos(stack[depth - 1]); break;
      case 7: if (depth < 1) return null; stack[depth - 1] = Math.abs(stack[depth - 1]); break;
      case 8: if (depth < 1) return null; stack[depth - 1] = Math.min(operands[1], Math.max(operands[0], stack[depth - 1])); break;
      case 9: if (depth < 1) return null;
        stack[depth - 1] = operands[2] + (stack[depth - 1] - operands[0]) / (operands[1] - operands[0]) * (operands[3] - operands[2]);
        break;
      case 10: if (depth < 1) return null;
        value = Math.min(1, Math.max(0, (stack[depth - 1] - operands[0]) / (operands[1] - operands[0])));
        stack[depth - 1] = value * value * (3 - 2 * value);
        break;
      default: return null;
    }
    if (!Number.isFinite(stack[depth - 1])) return null;
  }
  return depth === 1 ? stack[0] : null;
}

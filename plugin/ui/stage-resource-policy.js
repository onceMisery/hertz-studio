// SPDX-License-Identifier: MIT
// Finite development envelope. These API work limits are not device capacity or release qualification.
(function (global) {
  'use strict';
  var MiB = 1024 * 1024;
  global.StageResourcePolicy = Object.freeze({ contractVersion: 1, policyVersion: 'm1-development-v1',
    qualification: 'candidate-coverage-incomplete',
    basis: 'Initial finite declared-work envelope; calibrate full host combinations before M1 release.',
    caps: Object.freeze({ gpuContexts: 16, canvases: 64, drawingBufferPixels: 32 * 1024 * 1024,
      programs: 128, renderTargetDeclaredBytes: 256 * MiB, textureDeclaredBytes: 256 * MiB,
      bufferDeclaredBytes: 128 * MiB, ownedCpuBytes: 128 * MiB,
      decodeReservedBytes: 64 * MiB, decoderLeases: 8 }) });
})(window);

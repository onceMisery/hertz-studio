// SPDX-License-Identifier: LicenseRef-CanvasUI-Commons-Clause
// Copyright (c) 2026 David Haz; adaptations (c) 2026 hertz-studio contributors.
// Fluid solver adapted from Canvas UI LiquidVanilla.ts, commit
// a04a99b235299ee79a123a16ccb2e6cf9da74b6b. See ../LICENSE.md.
// Hertz Studio owns scheduling, input, visibility and disposal.

import { VERT, FRAG_SPLAT, FRAG_ADVECT, FRAG_CLEAR, FRAG_DIVERGENCE,
  FRAG_CURL, FRAG_VORTICITY, FRAG_PRESSURE, FRAG_GRADIENT } from './shaders.js';

const DISPLAY = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uFluid;
uniform vec3 uColor;
uniform float uStrength;
void main(){
  float density=length(texture(uFluid,vUv).rgb);
  vec2 p=(vUv-.5)*2.;
  float edge=1.-smoothstep(.72,1.,length(p));
  float alpha=min(.62,(1.-exp(-density*.9))*.62)*uStrength*edge;
  outColor=vec4(uColor*alpha,alpha);
}`;

export const profiles = Object.freeze({
  2: Object.freeze({ fps: 20, simulation: 64, dye: 128, pixels: 1000000 })
});

export function create(canvas, tier) {
  let gl, disposed = false, fluid = null, quad = null, profile = profiles[tier];
  const textures = [], framebuffers = [], programs = [], shaders = [];
  let bytes = 0, frames = 0, steps = 0, drawCalls = 0, strength = .35;
  const color = new Float32Array([.65, .55, .4]);

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (gl) {
      textures.forEach(value => gl.deleteTexture(value));
      framebuffers.forEach(value => gl.deleteFramebuffer(value));
      programs.forEach(value => gl.deleteProgram(value));
      shaders.forEach(value => gl.deleteShader(value));
      if (quad) gl.deleteBuffer(quad);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const loss = gl.getExtension('WEBGL_lose_context');
      if (loss && !gl.isContextLost()) loss.loseContext();
    }
    textures.length = framebuffers.length = programs.length = shaders.length = 0;
    bytes = 0; quad = null; fluid = null;
  }
  function fail(message, code) {
    const error = new Error(message); error.code = code || 'FLUID_INITIALIZATION';
    throw error;
  }
  function compile(type, source) {
    const shader = gl.createShader(type);
    if (!shader) fail('无法创建流体着色器');
    shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) fail(gl.getShaderInfoLog(shader) || '流体着色器编译失败');
    return shader;
  }
  function program(vertex, fragment) {
    const value = gl.createProgram();
    if (!value) fail('无法创建流体程序');
    programs.push(value); gl.attachShader(value, vertex);
    gl.attachShader(value, compile(gl.FRAGMENT_SHADER, fragment)); gl.linkProgram(value);
    if (!gl.getProgramParameter(value, gl.LINK_STATUS)) fail(gl.getProgramInfoLog(value) || '流体程序链接失败');
    const uniforms = Object.create(null), count = gl.getProgramParameter(value, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(value, i);
      uniforms[info.name] = gl.getUniformLocation(value, info.name);
    }
    return { value, u: uniforms };
  }
  function target(size, internal, format, filter, stride) {
    const texture = gl.createTexture(), fbo = gl.createFramebuffer();
    if (texture) textures.push(texture);
    if (fbo) framebuffers.push(fbo);
    if (!texture || !fbo) fail('流体缓冲分配失败');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, size, size, 0, format, gl.HALF_FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) fail('当前设备不支持流体缓冲', 'UNSUPPORTED_FLOAT');
    gl.viewport(0, 0, size, size); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    bytes += size * size * stride;
    return { texture, fbo, size };
  }
  function pair(size, internal, format, filter, stride) {
    return { read: target(size, internal, format, filter, stride), write: target(size, internal, format, filter, stride) };
  }
  function swap(value) { const previous = value.read; value.read = value.write; value.write = previous; }
  function bind(texture, unit) {
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture); return unit;
  }
  function blit(to) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, to ? to.fbo : null);
    gl.viewport(0, 0, to ? to.size : canvas.width, to ? to.size : canvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); drawCalls++;
  }
  let display, splatProgram, advect, clear, divergence, curl, vorticity, pressure, gradient;
  try {
    if (!profile) fail('当前画质暂不启用流体增强', 'UNSUPPORTED_TIER');
    gl = canvas.getContext('webgl2', { alpha: true, depth: false, stencil: false,
      antialias: false, premultipliedAlpha: true, powerPreference: 'low-power' });
    if (!gl || gl.isContextLost()) fail('当前设备不支持此效果', 'UNSUPPORTED_WEBGL');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) fail('当前设备不支持流体缓冲', 'UNSUPPORTED_FLOAT');
    const filter = gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST;
    const vertex = compile(gl.VERTEX_SHADER, VERT);
    display = program(vertex, DISPLAY); splatProgram = program(vertex, FRAG_SPLAT);
    advect = program(vertex, FRAG_ADVECT); clear = program(vertex, FRAG_CLEAR);
    divergence = program(vertex, FRAG_DIVERGENCE); curl = program(vertex, FRAG_CURL);
    vorticity = program(vertex, FRAG_VORTICITY); pressure = program(vertex, FRAG_PRESSURE);
    gradient = program(vertex, FRAG_GRADIENT);
    quad = gl.createBuffer(); if (!quad) fail('流体顶点分配失败');
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    fluid = {
      velocity: pair(profile.simulation, gl.RG16F, gl.RG, filter, 4),
      dye: pair(profile.dye, gl.RGBA16F, gl.RGBA, filter, 8),
      pressure: pair(profile.simulation, gl.R16F, gl.RED, gl.NEAREST, 2),
      divergence: target(profile.simulation, gl.R16F, gl.RED, gl.NEAREST, 2),
      curl: target(profile.simulation, gl.R16F, gl.RED, gl.NEAREST, 2)
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.disable(gl.BLEND);
  } catch (error) { dispose(); throw error; }

  function splat(x, y, dx, dy, amount) {
    if (disposed) return;
    gl.useProgram(splatProgram.value);
    gl.uniform1f(splatProgram.u.uAspect, canvas.width / Math.max(1, canvas.height));
    gl.uniform2f(splatProgram.u.uPoint, x, y); gl.uniform1f(splatProgram.u.uRadius, .0028);
    gl.uniform1i(splatProgram.u.uTarget, bind(fluid.velocity.read.texture, 0));
    gl.uniform3f(splatProgram.u.uColor, Math.max(-250, Math.min(250, dx)), Math.max(-250, Math.min(250, dy)), 0);
    blit(fluid.velocity.write); swap(fluid.velocity);
    gl.uniform1i(splatProgram.u.uTarget, bind(fluid.dye.read.texture, 0));
    const dye = Math.max(0, Math.min(2, amount));
    gl.uniform3f(splatProgram.u.uColor, dye, dye * .7, dye * .4);
    blit(fluid.dye.write); swap(fluid.dye);
  }
  function solve(dt) {
    const texel = 1 / profile.simulation;
    gl.useProgram(curl.value); gl.uniform2f(curl.u.texelSize, texel, texel);
    gl.uniform1i(curl.u.uVelocity, bind(fluid.velocity.read.texture, 0)); blit(fluid.curl);
    gl.useProgram(vorticity.value); gl.uniform2f(vorticity.u.texelSize, texel, texel);
    gl.uniform1i(vorticity.u.uVelocity, bind(fluid.velocity.read.texture, 0));
    gl.uniform1i(vorticity.u.uCurl, bind(fluid.curl.texture, 1));
    gl.uniform1f(vorticity.u.uCurlStrength, 9); gl.uniform1f(vorticity.u.uDt, dt);
    blit(fluid.velocity.write); swap(fluid.velocity);
    gl.useProgram(divergence.value); gl.uniform2f(divergence.u.texelSize, texel, texel);
    gl.uniform1i(divergence.u.uVelocity, bind(fluid.velocity.read.texture, 0)); blit(fluid.divergence);
    gl.useProgram(clear.value); gl.uniform1i(clear.u.uTexture, bind(fluid.pressure.read.texture, 0));
    gl.uniform1f(clear.u.uValue, Math.pow(.8, dt * 60)); blit(fluid.pressure.write); swap(fluid.pressure);
    gl.useProgram(pressure.value); gl.uniform2f(pressure.u.texelSize, texel, texel);
    gl.uniform1i(pressure.u.uDivergence, bind(fluid.divergence.texture, 0));
    for (let i = 0; i < 4; i++) {
      gl.uniform1i(pressure.u.uPressure, bind(fluid.pressure.read.texture, 1));
      blit(fluid.pressure.write); swap(fluid.pressure);
    }
    gl.useProgram(gradient.value); gl.uniform2f(gradient.u.texelSize, texel, texel);
    gl.uniform1i(gradient.u.uPressure, bind(fluid.pressure.read.texture, 0));
    gl.uniform1i(gradient.u.uVelocity, bind(fluid.velocity.read.texture, 1));
    blit(fluid.velocity.write); swap(fluid.velocity);
    gl.useProgram(advect.value); gl.uniform2f(advect.u.texelSize, texel, texel);
    gl.uniform1f(advect.u.uDt, dt);
    gl.uniform1i(advect.u.uVelocity, bind(fluid.velocity.read.texture, 0));
    gl.uniform1i(advect.u.uSource, 0); gl.uniform1f(advect.u.uDissipation, Math.pow(.992, dt * 60));
    blit(fluid.velocity.write); swap(fluid.velocity);
    gl.uniform1i(advect.u.uVelocity, bind(fluid.velocity.read.texture, 0));
    gl.uniform1i(advect.u.uSource, bind(fluid.dye.read.texture, 1));
    gl.uniform1f(advect.u.uDissipation, Math.pow(.986, dt * 60));
    blit(fluid.dye.write); swap(fluid.dye); steps++;
  }
  function step(dtSeconds) {
    if (disposed || !Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    // Semi-Lagrangian advection accepts the bounded elapsed time directly.
    // One normalized step avoids doubling all passes at the 20/30fps gate.
    solve(Math.min(.05, dtSeconds));
  }
  function render() {
    if (disposed) return;
    gl.useProgram(display.value); gl.uniform1i(display.u.uFluid, bind(fluid.dye.read.texture, 0));
    gl.uniform3fv(display.u.uColor, color); gl.uniform1f(display.u.uStrength, strength);
    blit(null); frames++;
  }
  function reset() {
    if (disposed) return;
    gl.clearColor(0, 0, 0, 0);
    framebuffers.forEach(fbo => { gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.clear(gl.COLOR_BUFFER_BIT); });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clear(gl.COLOR_BUFFER_BIT);
  }
  function resize(width, height) {
    if (disposed) return;
    const ratio = Math.min(1, window.devicePixelRatio || 1,
      Math.sqrt(profile.pixels / Math.max(1, width * height)),
      gl.getParameter(gl.MAX_TEXTURE_SIZE) / Math.max(1, width, height));
    canvas.width = Math.max(1, Math.floor(width * ratio));
    canvas.height = Math.max(1, Math.floor(height * ratio));
  }
  return {
    splat, step, render, reset, resize, dispose,
    configure(rgb, amount) {
      if (disposed) return;
      for (let i = 0; i < 3; i++) color[i] = Math.max(0, Math.min(1, rgb[i]));
      strength = Math.max(0, Math.min(1, amount));
    },
    stats() {
      return { contexts: disposed ? 0 : 1, textures: textures.length, framebuffers: framebuffers.length,
        programs: programs.length, buffers: quad ? 1 : 0, shaders: shaders.length, estimatedBytes: bytes,
        outputPixels: disposed ? 0 : canvas.width * canvas.height, frames, steps, drawCalls, disposed };
    }
  };
}

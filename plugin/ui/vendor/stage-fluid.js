/*!
 * Canvas UI fluid solver, adapted for Hertz Studio.
 * Upstream: DavidHDev/canvas-ui a04a99b235299ee79a123a16ccb2e6cf9da74b6b.
 * SPDX-License-Identifier: LicenseRef-CanvasUI-Commons-Clause
 * # MIT + Commons Clause License Condition v1.0
 * 
 * Copyright (c) 2026 David Haz
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, and distribute the Software **as part of
 * an application, website, or product**, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * ## Commons Clause Restriction
 * 
 * You may use this Software, including for any commercial purpose, **so long as
 * you do not sell, sublicense, or redistribute the components themselves -
 * whether alone, in a bundle, or as a ported version.**
 * 
 * ## No Warranty
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
var HertzFluidEngine=(()=>{var V=Object.defineProperty;var ie=Object.getOwnPropertyDescriptor;var ne=Object.getOwnPropertyNames;var le=Object.prototype.hasOwnProperty;var ae=(i,f)=>{for(var e in f)V(i,e,{get:f[e],enumerable:!0})},fe=(i,f,e,l)=>{if(f&&typeof f=="object"||typeof f=="function")for(let o of ne(f))!le.call(i,o)&&o!==e&&V(i,o,{get:()=>f[o],enumerable:!(l=ie(f,o))||l.enumerable});return i};var ve=i=>fe(V({},"__esModule",{value:!0}),i);var me={};ae(me,{create:()=>se,profiles:()=>Q});var W=`#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
out vec2 vL;
out vec2 vR;
out vec2 vT;
out vec2 vB;
uniform vec2 texelSize;
void main () {
  vUv = aPos * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`,Y=`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTarget;
uniform float uAspect;
uniform vec3 uColor;
uniform vec2 uPoint;
uniform float uRadius;
void main () {
  vec2 p = vUv - uPoint;
  p.x *= uAspect;
  vec3 splat = exp(-dot(p, p) / uRadius) * uColor;
  vec3 base = texture(uTarget, vUv).xyz;
  outColor = vec4(base + splat, 1.0);
}`,H=`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform float uDt;
uniform float uDissipation;
void main () {
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * texelSize;
  outColor = uDissipation * texture(uSource, coord);
  outColor.a = 1.0;
}`,j=`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTexture;
uniform float uValue;
void main () {
  outColor = uValue * texture(uTexture, vUv);
}`,k=`#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 outColor;
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).x;
  float R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y;
  float B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if (vL.x < 0.0) { L = -C.x; }
  if (vR.x > 1.0) { R = -C.x; }
  if (vT.y > 1.0) { T = -C.y; }
  if (vB.y < 0.0) { B = -C.y; }
  float div = 0.5 * (R - L + T - B);
  outColor = vec4(div, 0.0, 0.0, 1.0);
}`,q=`#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 outColor;
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).y;
  float R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x;
  float B = texture(uVelocity, vB).x;
  float vorticity = R - L - T + B;
  outColor = vec4(vorticity, 0.0, 0.0, 1.0);
}`,Z=`#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 outColor;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float uCurlStrength;
uniform float uDt;
void main () {
  float L = texture(uCurl, vL).x;
  float R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x;
  float B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = vec2(abs(T) - abs(B), abs(R) - abs(L)) * 0.5;
  force /= length(force) + 1.0;
  force *= uCurlStrength * C;
  force.y *= -1.0;
  vec2 velocity = texture(uVelocity, vUv).xy;
  outColor = vec4(velocity + force * uDt, 0.0, 1.0);
}`,K=`#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 outColor;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main () {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  float divergence = texture(uDivergence, vUv).x;
  float pressure = (L + R + B + T - divergence) * 0.25;
  outColor = vec4(pressure, 0.0, 0.0, 1.0);
}`,J=`#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 outColor;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main () {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  vec2 velocity = texture(uVelocity, vUv).xy;
  velocity.xy -= vec2(R - L, T - B);
  outColor = vec4(velocity, 0.0, 1.0);
}`;var ce=`#version 300 es
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
}`,Q=Object.freeze({2:Object.freeze({fps:20,simulation:64,dye:128,pixels:1e6})});function se(i,f){let e,l=!1,o=null,d=null,E=Q[f],U=[],y=[],C=[],P=[],b=0,I=0,w=0,G=0,O=.35,N=new Float32Array([.65,.55,.4]);function X(){if(!l){if(l=!0,e){U.forEach(r=>e.deleteTexture(r)),y.forEach(r=>e.deleteFramebuffer(r)),C.forEach(r=>e.deleteProgram(r)),P.forEach(r=>e.deleteShader(r)),d&&e.deleteBuffer(d),e.bindFramebuffer(e.FRAMEBUFFER,null);let t=e.getExtension("WEBGL_lose_context");t&&!e.isContextLost()&&t.loseContext()}U.length=y.length=C.length=P.length=0,b=0,d=null,o=null}}function c(t,r){let u=new Error(t);throw u.code=r||"FLUID_INITIALIZATION",u}function z(t,r){let u=e.createShader(t);return u||c("\u65E0\u6CD5\u521B\u5EFA\u6D41\u4F53\u7740\u8272\u5668"),P.push(u),e.shaderSource(u,r),e.compileShader(u),e.getShaderParameter(u,e.COMPILE_STATUS)||c(e.getShaderInfoLog(u)||"\u6D41\u4F53\u7740\u8272\u5668\u7F16\u8BD1\u5931\u8D25"),u}function x(t,r){let u=e.createProgram();u||c("\u65E0\u6CD5\u521B\u5EFA\u6D41\u4F53\u7A0B\u5E8F"),C.push(u),e.attachShader(u,t),e.attachShader(u,z(e.FRAGMENT_SHADER,r)),e.linkProgram(u),e.getProgramParameter(u,e.LINK_STATUS)||c(e.getProgramInfoLog(u)||"\u6D41\u4F53\u7A0B\u5E8F\u94FE\u63A5\u5931\u8D25");let m=Object.create(null),p=e.getProgramParameter(u,e.ACTIVE_UNIFORMS);for(let a=0;a<p;a++){let h=e.getActiveUniform(u,a);m[h.name]=e.getUniformLocation(u,h.name)}return{value:u,u:m}}function L(t,r,u,m,p){let a=e.createTexture(),h=e.createFramebuffer();return a&&U.push(a),h&&y.push(h),(!a||!h)&&c("\u6D41\u4F53\u7F13\u51B2\u5206\u914D\u5931\u8D25"),e.bindTexture(e.TEXTURE_2D,a),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,m),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,m),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,r,t,t,0,u,e.HALF_FLOAT,null),e.bindFramebuffer(e.FRAMEBUFFER,h),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,a,0),e.checkFramebufferStatus(e.FRAMEBUFFER)!==e.FRAMEBUFFER_COMPLETE&&c("\u5F53\u524D\u8BBE\u5907\u4E0D\u652F\u6301\u6D41\u4F53\u7F13\u51B2","UNSUPPORTED_FLOAT"),e.viewport(0,0,t,t),e.clearColor(0,0,0,0),e.clear(e.COLOR_BUFFER_BIT),b+=t*t*p,{texture:a,fbo:h,size:t}}function M(t,r,u,m,p){return{read:L(t,r,u,m,p),write:L(t,r,u,m,p)}}function T(t){let r=t.read;t.read=t.write,t.write=r}function n(t,r){return e.activeTexture(e.TEXTURE0+r),e.bindTexture(e.TEXTURE_2D,t),r}function v(t){e.bindFramebuffer(e.FRAMEBUFFER,t?t.fbo:null),e.viewport(0,0,t?t.size:i.width,t?t.size:i.height),e.drawArrays(e.TRIANGLE_STRIP,0,4),G++}let F,R,s,D,S,B,g,A,_;try{E||c("\u5F53\u524D\u753B\u8D28\u6682\u4E0D\u542F\u7528\u6D41\u4F53\u589E\u5F3A","UNSUPPORTED_TIER"),e=i.getContext("webgl2",{alpha:!0,depth:!1,stencil:!1,antialias:!1,premultipliedAlpha:!0,powerPreference:"low-power"}),(!e||e.isContextLost())&&c("\u5F53\u524D\u8BBE\u5907\u4E0D\u652F\u6301\u6B64\u6548\u679C","UNSUPPORTED_WEBGL"),!e.getExtension("EXT_color_buffer_float")&&!e.getExtension("EXT_color_buffer_half_float")&&c("\u5F53\u524D\u8BBE\u5907\u4E0D\u652F\u6301\u6D41\u4F53\u7F13\u51B2","UNSUPPORTED_FLOAT");let t=e.getExtension("OES_texture_float_linear")?e.LINEAR:e.NEAREST,r=z(e.VERTEX_SHADER,W);F=x(r,ce),R=x(r,Y),s=x(r,H),D=x(r,j),S=x(r,k),B=x(r,q),g=x(r,Z),A=x(r,K),_=x(r,J),d=e.createBuffer(),d||c("\u6D41\u4F53\u9876\u70B9\u5206\u914D\u5931\u8D25"),e.bindBuffer(e.ARRAY_BUFFER,d),e.bufferData(e.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),e.STATIC_DRAW),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0),o={velocity:M(E.simulation,e.RG16F,e.RG,t,4),dye:M(E.dye,e.RGBA16F,e.RGBA,t,8),pressure:M(E.simulation,e.R16F,e.RED,e.NEAREST,2),divergence:L(E.simulation,e.R16F,e.RED,e.NEAREST,2),curl:L(E.simulation,e.R16F,e.RED,e.NEAREST,2)},e.bindFramebuffer(e.FRAMEBUFFER,null),e.disable(e.BLEND)}catch(t){throw X(),t}function $(t,r,u,m,p){if(l)return;e.useProgram(R.value),e.uniform1f(R.u.uAspect,i.width/Math.max(1,i.height)),e.uniform2f(R.u.uPoint,t,r),e.uniform1f(R.u.uRadius,.0028),e.uniform1i(R.u.uTarget,n(o.velocity.read.texture,0)),e.uniform3f(R.u.uColor,Math.max(-250,Math.min(250,u)),Math.max(-250,Math.min(250,m)),0),v(o.velocity.write),T(o.velocity),e.uniform1i(R.u.uTarget,n(o.dye.read.texture,0));let a=Math.max(0,Math.min(2,p));e.uniform3f(R.u.uColor,a,a*.7,a*.4),v(o.dye.write),T(o.dye)}function ee(t){let r=1/E.simulation;e.useProgram(B.value),e.uniform2f(B.u.texelSize,r,r),e.uniform1i(B.u.uVelocity,n(o.velocity.read.texture,0)),v(o.curl),e.useProgram(g.value),e.uniform2f(g.u.texelSize,r,r),e.uniform1i(g.u.uVelocity,n(o.velocity.read.texture,0)),e.uniform1i(g.u.uCurl,n(o.curl.texture,1)),e.uniform1f(g.u.uCurlStrength,9),e.uniform1f(g.u.uDt,t),v(o.velocity.write),T(o.velocity),e.useProgram(S.value),e.uniform2f(S.u.texelSize,r,r),e.uniform1i(S.u.uVelocity,n(o.velocity.read.texture,0)),v(o.divergence),e.useProgram(D.value),e.uniform1i(D.u.uTexture,n(o.pressure.read.texture,0)),e.uniform1f(D.u.uValue,Math.pow(.8,t*60)),v(o.pressure.write),T(o.pressure),e.useProgram(A.value),e.uniform2f(A.u.texelSize,r,r),e.uniform1i(A.u.uDivergence,n(o.divergence.texture,0));for(let u=0;u<4;u++)e.uniform1i(A.u.uPressure,n(o.pressure.read.texture,1)),v(o.pressure.write),T(o.pressure);e.useProgram(_.value),e.uniform2f(_.u.texelSize,r,r),e.uniform1i(_.u.uPressure,n(o.pressure.read.texture,0)),e.uniform1i(_.u.uVelocity,n(o.velocity.read.texture,1)),v(o.velocity.write),T(o.velocity),e.useProgram(s.value),e.uniform2f(s.u.texelSize,r,r),e.uniform1f(s.u.uDt,t),e.uniform1i(s.u.uVelocity,n(o.velocity.read.texture,0)),e.uniform1i(s.u.uSource,0),e.uniform1f(s.u.uDissipation,Math.pow(.992,t*60)),v(o.velocity.write),T(o.velocity),e.uniform1i(s.u.uVelocity,n(o.velocity.read.texture,0)),e.uniform1i(s.u.uSource,n(o.dye.read.texture,1)),e.uniform1f(s.u.uDissipation,Math.pow(.986,t*60)),v(o.dye.write),T(o.dye),w++}function te(t){l||!Number.isFinite(t)||t<=0||ee(Math.min(.05,t))}function re(){l||(e.useProgram(F.value),e.uniform1i(F.u.uFluid,n(o.dye.read.texture,0)),e.uniform3fv(F.u.uColor,N),e.uniform1f(F.u.uStrength,O),v(null),I++)}function oe(){l||(e.clearColor(0,0,0,0),y.forEach(t=>{e.bindFramebuffer(e.FRAMEBUFFER,t),e.clear(e.COLOR_BUFFER_BIT)}),e.bindFramebuffer(e.FRAMEBUFFER,null),e.clear(e.COLOR_BUFFER_BIT))}function ue(t,r){if(l)return;let u=Math.min(1,window.devicePixelRatio||1,Math.sqrt(E.pixels/Math.max(1,t*r)),e.getParameter(e.MAX_TEXTURE_SIZE)/Math.max(1,t,r));i.width=Math.max(1,Math.floor(t*u)),i.height=Math.max(1,Math.floor(r*u))}return{splat:$,step:te,render:re,reset:oe,resize:ue,dispose:X,configure(t,r){if(!l){for(let u=0;u<3;u++)N[u]=Math.max(0,Math.min(1,t[u]));O=Math.max(0,Math.min(1,r))}},stats(){return{contexts:l?0:1,textures:U.length,framebuffers:y.length,programs:C.length,buffers:d?1:0,shaders:P.length,estimatedBytes:b,outputPixels:l?0:i.width*i.height,frames:I,steps:w,drawCalls:G,disposed:l}}}}return ve(me);})();

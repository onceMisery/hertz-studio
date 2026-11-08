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
var HertzFluidEngine=(()=>{var X=Object.defineProperty;var ve=Object.getOwnPropertyDescriptor;var me=Object.getOwnPropertyNames;var xe=Object.prototype.hasOwnProperty;var Re=(i,s)=>{for(var y in s)X(i,y,{get:s[y],enumerable:!0})},de=(i,s,y,e)=>{if(s&&typeof s=="object"||typeof s=="function")for(let n of me(s))!xe.call(i,n)&&n!==y&&X(i,n,{get:()=>s[n],enumerable:!(e=ve(s,n))||e.enumerable});return i};var pe=i=>de(X({},"__esModule",{value:!0}),i);var he={};Re(he,{create:()=>Te,profiles:()=>ue});var Z=`#version 300 es
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
}`,K=`#version 300 es
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
}`,J=`#version 300 es
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
}`,Q=`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTexture;
uniform float uValue;
void main () {
  outColor = uValue * texture(uTexture, vUv);
}`,$=`#version 300 es
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
}`,ee=`#version 300 es
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
}`,re=`#version 300 es
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
}`,te=`#version 300 es
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
}`,oe=`#version 300 es
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
}`;var Ee=`#version 300 es
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
}`,ue=Object.freeze({2:Object.freeze({fps:20,simulation:64,dye:128,pixels:1e6})});function Te(i,s,y={}){let e,n=!1,u=null,h=null,m=ue[s],C=y.resources;if(!C||C.contractVersion!==1)throw new Error("resource-policy-required");if(!m){let r=new Error("\u5F53\u524D\u753B\u8D28\u6682\u4E0D\u542F\u7528\u6D41\u4F53\u589E\u5F3A");throw r.code="UNSUPPORTED_TIER",r}let ie=m.simulation**2*16+m.dye**2*16,z=C.require({gpuContexts:1,programs:9,renderTargetDeclaredBytes:ie,bufferDeclaredBytes:32,ownedCpuBytes:12},"fluid fixed resources: RG16F/R16F/RGBA16F, no depth or MSAA",0),F=null,A=null,I=!1,B=[],_=[],L=[],S=[],O=0,k=0,q=0,W=0,H=.35,b=null;function Y(){if(n)return;n=!0;function r(t){try{t()}catch(o){I=!0}}if(e&&(B.forEach(t=>r(()=>e.deleteTexture(t))),_.forEach(t=>r(()=>e.deleteFramebuffer(t))),L.forEach(t=>r(()=>e.deleteProgram(t))),S.forEach(t=>r(()=>e.deleteShader(t))),h&&r(()=>e.deleteBuffer(h)),r(()=>{e.bindFramebuffer(e.FRAMEBUFFER,null);let t=e.getExtension("WEBGL_lose_context");t&&!e.isContextLost()&&t.loseContext()})),r(()=>{i.width=0}),r(()=>{i.height=0}),B.length=_.length=L.length=S.length=0,O=0,h=null,u=null,e=null,b=null,!I){for(let t of[z,F,A])t&&t.release({apiReleased:!0,allocationEnded:!0});F=A=null}}function R(r,t){let o=new Error(r);throw o.code=t||"FLUID_INITIALIZATION",o}function j(r,t){let o=e.createShader(r);return o||R("\u65E0\u6CD5\u521B\u5EFA\u6D41\u4F53\u7740\u8272\u5668"),S.push(o),e.shaderSource(o,t),e.compileShader(o),e.getShaderParameter(o,e.COMPILE_STATUS)||R(e.getShaderInfoLog(o)||"\u6D41\u4F53\u7740\u8272\u5668\u7F16\u8BD1\u5931\u8D25"),o}function d(r,t){let o=e.createProgram();o||R("\u65E0\u6CD5\u521B\u5EFA\u6D41\u4F53\u7A0B\u5E8F"),L.push(o),e.attachShader(o,r),e.attachShader(o,j(e.FRAGMENT_SHADER,t)),e.linkProgram(o),e.getProgramParameter(o,e.LINK_STATUS)||R(e.getProgramInfoLog(o)||"\u6D41\u4F53\u7A0B\u5E8F\u94FE\u63A5\u5931\u8D25");let l=Object.create(null),c=e.getProgramParameter(o,e.ACTIVE_UNIFORMS);for(let a=0;a<c;a++){let T=e.getActiveUniform(o,a);l[T.name]=e.getUniformLocation(o,T.name)}return{value:o,u:l}}function M(r,t,o,l,c){let a=e.createTexture(),T=e.createFramebuffer();return a&&B.push(a),T&&_.push(T),(!a||!T)&&R("\u6D41\u4F53\u7F13\u51B2\u5206\u914D\u5931\u8D25"),e.bindTexture(e.TEXTURE_2D,a),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,l),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,l),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,t,r,r,0,o,e.HALF_FLOAT,null),e.bindFramebuffer(e.FRAMEBUFFER,T),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,a,0),e.checkFramebufferStatus(e.FRAMEBUFFER)!==e.FRAMEBUFFER_COMPLETE&&R("\u5F53\u524D\u8BBE\u5907\u4E0D\u652F\u6301\u6D41\u4F53\u7F13\u51B2","UNSUPPORTED_FLOAT"),e.viewport(0,0,r,r),e.clearColor(0,0,0,0),e.clear(e.COLOR_BUFFER_BIT),O+=r*r*c,{texture:a,fbo:T,size:r}}function N(r,t,o,l,c){return{read:M(r,t,o,l,c),write:M(r,t,o,l,c)}}function E(r){let t=r.read;r.read=r.write,r.write=t}function f(r,t){return e.activeTexture(e.TEXTURE0+t),e.bindTexture(e.TEXTURE_2D,r),t}function v(r){e.bindFramebuffer(e.FRAMEBUFFER,r?r.fbo:null),e.viewport(0,0,r?r.size:i.width,r?r.size:i.height),e.drawArrays(e.TRIANGLE_STRIP,0,4),W++}let U,p,x,w,V,G,g,P,D;try{b=new Float32Array([.65,.55,.4]),e=i.getContext("webgl2",{alpha:!0,depth:!1,stencil:!1,antialias:!1,premultipliedAlpha:!0,powerPreference:"low-power"}),(!e||e.isContextLost())&&R("\u5F53\u524D\u8BBE\u5907\u4E0D\u652F\u6301\u6B64\u6548\u679C","UNSUPPORTED_WEBGL"),!e.getExtension("EXT_color_buffer_float")&&!e.getExtension("EXT_color_buffer_half_float")&&R("\u5F53\u524D\u8BBE\u5907\u4E0D\u652F\u6301\u6D41\u4F53\u7F13\u51B2","UNSUPPORTED_FLOAT");let r=e.getExtension("OES_texture_float_linear")?e.LINEAR:e.NEAREST,t=j(e.VERTEX_SHADER,Z);U=d(t,Ee),p=d(t,K),x=d(t,J),w=d(t,Q),V=d(t,$),G=d(t,ee),g=d(t,re),P=d(t,te),D=d(t,oe),h=e.createBuffer(),h||R("\u6D41\u4F53\u9876\u70B9\u5206\u914D\u5931\u8D25"),e.bindBuffer(e.ARRAY_BUFFER,h);let o=C.require({ownedCpuBytes:32},"fluid transient Float32 quad upload",0),l=null;try{l=new Float32Array([-1,-1,1,-1,-1,1,1,1]),o.commit(),e.bufferData(e.ARRAY_BUFFER,l,e.STATIC_DRAW)}finally{l=null,o.release({apiReleased:!0,allocationEnded:!0})}e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0),u={velocity:N(m.simulation,e.RG16F,e.RG,r,4),dye:N(m.dye,e.RGBA16F,e.RGBA,r,8),pressure:N(m.simulation,e.R16F,e.RED,e.NEAREST,2),divergence:M(m.simulation,e.R16F,e.RED,e.NEAREST,2),curl:M(m.simulation,e.R16F,e.RED,e.NEAREST,2)},e.bindFramebuffer(e.FRAMEBUFFER,null),e.disable(e.BLEND),z.commit()}catch(r){throw Y(),r}function le(r,t,o,l,c){if(n)return;e.useProgram(p.value),e.uniform1f(p.u.uAspect,i.width/Math.max(1,i.height)),e.uniform2f(p.u.uPoint,r,t),e.uniform1f(p.u.uRadius,.0028),e.uniform1i(p.u.uTarget,f(u.velocity.read.texture,0)),e.uniform3f(p.u.uColor,Math.max(-250,Math.min(250,o)),Math.max(-250,Math.min(250,l)),0),v(u.velocity.write),E(u.velocity),e.uniform1i(p.u.uTarget,f(u.dye.read.texture,0));let a=Math.max(0,Math.min(2,c));e.uniform3f(p.u.uColor,a,a*.7,a*.4),v(u.dye.write),E(u.dye)}function ne(r){let t=1/m.simulation;e.useProgram(G.value),e.uniform2f(G.u.texelSize,t,t),e.uniform1i(G.u.uVelocity,f(u.velocity.read.texture,0)),v(u.curl),e.useProgram(g.value),e.uniform2f(g.u.texelSize,t,t),e.uniform1i(g.u.uVelocity,f(u.velocity.read.texture,0)),e.uniform1i(g.u.uCurl,f(u.curl.texture,1)),e.uniform1f(g.u.uCurlStrength,9),e.uniform1f(g.u.uDt,r),v(u.velocity.write),E(u.velocity),e.useProgram(V.value),e.uniform2f(V.u.texelSize,t,t),e.uniform1i(V.u.uVelocity,f(u.velocity.read.texture,0)),v(u.divergence),e.useProgram(w.value),e.uniform1i(w.u.uTexture,f(u.pressure.read.texture,0)),e.uniform1f(w.u.uValue,Math.pow(.8,r*60)),v(u.pressure.write),E(u.pressure),e.useProgram(P.value),e.uniform2f(P.u.texelSize,t,t),e.uniform1i(P.u.uDivergence,f(u.divergence.texture,0));for(let o=0;o<4;o++)e.uniform1i(P.u.uPressure,f(u.pressure.read.texture,1)),v(u.pressure.write),E(u.pressure);e.useProgram(D.value),e.uniform2f(D.u.texelSize,t,t),e.uniform1i(D.u.uPressure,f(u.pressure.read.texture,0)),e.uniform1i(D.u.uVelocity,f(u.velocity.read.texture,1)),v(u.velocity.write),E(u.velocity),e.useProgram(x.value),e.uniform2f(x.u.texelSize,t,t),e.uniform1f(x.u.uDt,r),e.uniform1i(x.u.uVelocity,f(u.velocity.read.texture,0)),e.uniform1i(x.u.uSource,0),e.uniform1f(x.u.uDissipation,Math.pow(.992,r*60)),v(u.velocity.write),E(u.velocity),e.uniform1i(x.u.uVelocity,f(u.velocity.read.texture,0)),e.uniform1i(x.u.uSource,f(u.dye.read.texture,1)),e.uniform1f(x.u.uDissipation,Math.pow(.986,r*60)),v(u.dye.write),E(u.dye),q++}function ae(r){n||!Number.isFinite(r)||r<=0||ne(Math.min(.05,r))}function fe(){n||(e.useProgram(U.value),e.uniform1i(U.u.uFluid,f(u.dye.read.texture,0)),e.uniform3fv(U.u.uColor,b),e.uniform1f(U.u.uStrength,H),v(null),k++)}function ce(){n||(e.clearColor(0,0,0,0),_.forEach(r=>{e.bindFramebuffer(e.FRAMEBUFFER,r),e.clear(e.COLOR_BUFFER_BIT)}),e.bindFramebuffer(e.FRAMEBUFFER,null),e.clear(e.COLOR_BUFFER_BIT))}function se(r,t){if(n)return;if(!Number.isFinite(r)||!Number.isFinite(t)||r<=0||t<=0)throw new Error("estimate-unavailable");let o=Math.min(1,window.devicePixelRatio||1,Math.sqrt(m.pixels/Math.max(1,r*t)),e.getParameter(e.MAX_TEXTURE_SIZE)/Math.max(1,r,t)),l=Math.max(1,Math.floor(r*o)),c=Math.max(1,Math.floor(t*o));if(l===i.width&&c===i.height&&F)return;let a=Math.max(l*i.height,l*c);A=C.require({drawingBufferPixels:a,renderTargetDeclaredBytes:a*4},"fluid resize RGBA8 old plus new and intermediate surface",0),i.width=l,i.height=c,A.commit({drawingBufferPixels:l*c,renderTargetDeclaredBytes:l*c*4}),F&&F.release({apiReleased:!0,allocationEnded:!0}),F=A,A=null}return{splat:le,step:ae,render:fe,reset:ce,resize:se,dispose:Y,configure(r,t){if(!n){for(let o=0;o<3;o++)b[o]=Math.max(0,Math.min(1,r[o]));H=Math.max(0,Math.min(1,t))}},stats(){return{contexts:n?0:1,textures:B.length,framebuffers:_.length,programs:L.length,buffers:h?1:0,shaders:S.length,estimatedBytes:O,outputPixels:n?0:i.width*i.height,frames:k,steps:q,drawCalls:W,disposed:n,cleanupFailed:I}}}}return pe(he);})();

// SPDX-License-Identifier: MIT
// Colour, light and atmosphere helpers for the phoenix performance. This file
// owns no artwork, geometry, UV, skinning or egg shape: everything here is a
// fragment-side colour curve or a baked noise texture consumed by shaders.
import { own } from './factories.js';

// Sub-unit values pass through unchanged (so dark detail and pixel budgets do
// not move); only the >1 HDR fire constants are rolled off. Scaling all three
// channels by the same factor keeps the hue instead of clipping to flat white.
export const phoenixColor = `
uniform float uWarm;
vec3 phoenixTone(vec3 c){
 float peak=max(c.r,max(c.g,c.b));
 float rolled=peak>1.0?1.0+(peak-1.0)/(1.0+(peak-1.0))*.42:peak;
 return c*(rolled/max(peak,1e-4));
}
vec3 phoenixWarm(vec3 c,float amount){
 float l=dot(c,vec3(.299,.587,.114));
 vec3 cold=mix(c,vec3(l*.90,l*1.00,l*1.10),.34);
 vec3 warm=mix(c,vec3(l*1.30,l*.95,l*.75),.55);
 return mix(cold,warm,clamp(amount,0.0,1.0));
}
vec3 phoenixFinish(vec3 c){return phoenixWarm(phoenixTone(c),uWarm);}
`;

// The deep-space backdrop used to evaluate 3 fbm calls (3-4 octaves, ~40 hash
// evaluations) per screen pixel. Bake the same two LODs once on the CPU: R is
// the 3-octave field, G adds the fourth octave for non-low quality.
const spaceHash = (x, y, period) => {
  const wx = ((x % period) + period) % period, wy = ((y % period) + period) % period;
  let h = Math.imul(wx + 193, 374761393) ^ Math.imul(wy + 571, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

function spaceNoise(x, y, period) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx *= fx * (3 - 2 * fx); fy *= fy * (3 - 2 * fy);
  const a = spaceHash(ix, iy, period), b = spaceHash(ix + 1, iy, period);
  const c = spaceHash(ix, iy + 1, period), d = spaceHash(ix + 1, iy + 1, period);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

export function createSpaceNoise(ctx) {
  const T = ctx.THREE, size = 256, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + .5) / size, v = (y + .5) / size;
    const broad = spaceNoise(u * 4, v * 4, 4) * .53
      + spaceNoise(u * 8 + 11.3, v * 8 + 11.3, 8) * .28
      + spaceNoise(u * 16 + 23.7, v * 16 + 23.7, 16) * .13;
    const fine = broad + spaceNoise(u * 32 + 41.1, v * 32 + 41.1, 32) * .06;
    const k = (y * size + x) * 4;
    data[k] = Math.round(255 * Math.min(1, broad / .94));
    data[k + 1] = Math.round(255 * Math.min(1, fine));
    data[k + 2] = 0; data[k + 3] = 255;
  }
  const texture = own(ctx, new T.DataTexture(data, size, size, T.RGBAFormat));
  texture.name = 'phoenix-space-noise';
  texture.wrapS = texture.wrapT = T.RepeatWrapping;
  texture.magFilter = T.LinearFilter; texture.minFilter = T.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.needsUpdate = true;
  return texture;
}

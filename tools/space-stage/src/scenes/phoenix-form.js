// SPDX-License-Identifier: MIT
// Reference artwork, distant flock plumage and the shared egg surface.
import { own } from './factories.js';
import { unzlibSync } from 'three/examples/jsm/libs/fflate.module.js';
import { phoenixArt } from './assets/phoenix-reference-data.js';

const TAU = Math.PI * 2;
const WIDTH = 12.5, HEIGHT = WIDTH * phoenixArt.height / phoenixArt.width;
let artworkPixels;

function pixels() {
  if (artworkPixels) return artworkPixels;
  const compressed = Uint8Array.from(atob(phoenixArt.planes), char => char.charCodeAt(0));
  const planes = unzlibSync(compressed), count = phoenixArt.width * phoenixArt.height;
  if (planes.length !== count * 2) throw new Error('Invalid phoenix artwork');
  artworkPixels = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const color = planes[i] * 3, dest = i * 4;
    artworkPixels[dest] = phoenixArt.palette[color];
    artworkPixels[dest + 1] = phoenixArt.palette[color + 1];
    artworkPixels[dest + 2] = phoenixArt.palette[color + 2];
    artworkPixels[dest + 3] = planes[count + i];
  }
  return artworkPixels;
}

export function createPhoenixArtwork(ctx) {
  const T = ctx.THREE;
  const texture = own(ctx, new T.DataTexture(pixels(), phoenixArt.width, phoenixArt.height, T.RGBAFormat));
  texture.name = 'phoenix-reference-artwork';
  texture.colorSpace = T.SRGBColorSpace;
  texture.magFilter = T.LinearFilter; texture.minFilter = T.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.needsUpdate = true;
  return texture;
}

function profile(x, y) {
  const spine = .12 + .12 * Math.sin(y * .8);
  const breast = Math.exp(-Math.pow((x - spine) / .64, 2) - Math.pow((y - .65) / 2.5, 4));
  const neck = Math.exp(-Math.pow((x - .12) / .36, 2) - Math.pow((y - 2.75) / 1.1, 2));
  const wing = Math.exp(-Math.pow((Math.abs(x) - 1.6) / 2.4, 2) - Math.pow((y - 1.6) / 2.6, 2));
  const span = Math.max(0, Math.abs(x) - 1);
  return { center: Math.sin(x * .7) * .06 + span * .085 + wing * Math.sin((y - 1.1) * .85) * .32,
    depth: .045 + breast * .67 + neck * .28 + wing * .16 };
}

// Keep the approved painting's complete silhouette and UV layout. Depth is a
// shallow relief of that artwork, not a substitute anatomical character.
export function buildPhoenixReference(ctx, columns = 112, rows = 120) {
  const T = ctx.THREE, positions = [], uvs = [], surfaces = [], indices = [];
  const rgba = pixels(), width = phoenixArt.width, height = phoenixArt.height;
  const alpha = (u, v) => rgba[(Math.min(height - 1, Math.round(v * (height - 1))) * width + Math.min(width - 1, Math.round(u * (width - 1)))) * 4 + 3] / 255;
  const grid = [], vertexIndices = new Map();
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
    const u = col / columns, v = row / rows;
    grid.push({ x: (u - .5) * WIDTH, y: (.55 - v) * HEIGHT, u, v, alpha: alpha(u, v) });
  }
  function vertex(point, surface, face = surface) {
    const { x, y, u, v } = point;
    const key = `${Math.round(u * 1e7)}:${Math.round(v * 1e7)}:${surface}:${face}`;
    if (vertexIndices.has(key)) return vertexIndices.get(key);
    const shape = profile(x, y), index = positions.length / 3;
    vertexIndices.set(key, index);
    const rim = .35 + .65 * Math.min(1, Math.max(0, (point.alpha - .12) / .6));
    positions.push(x, y, shape.center + shape.depth * rim * surface);
    uvs.push(u, v); surfaces.push(face);
    return index;
  }
  function triangle(points) {
    const polygon = [], threshold = .12;
    for (let i = 0; i < 3; i++) {
      const a = points[i], b = points[(i + 1) % 3], insideA = a.alpha >= threshold, insideB = b.alpha >= threshold;
      if (insideA) polygon.push(a);
      if (insideA !== insideB) {
        const t = (threshold - a.alpha) / (b.alpha - a.alpha);
        polygon.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
          u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t, alpha: threshold, edge: true });
      }
    }
    if (polygon.length < 3) return;
    const front = polygon.map(p => vertex(p, 1)), back = polygon.map(p => vertex(p, -1));
    for (let i = 1; i < polygon.length - 1; i++) indices.push(front[0], front[i], front[i + 1], back[0], back[i + 1], back[i]);
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      if (!a.edge || !b.edge) continue;
      const af = vertex(a, 1, 0), ab = vertex(a, -1, 0), bf = vertex(b, 1, 0), bb = vertex(b, -1, 0);
      indices.push(af, ab, bf, ab, bb, bf);
    }
  }
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    const i = row * (columns + 1) + col, next = i + columns + 1;
    triangle([grid[i], grid[next], grid[i + 1]]);
    triangle([grid[next], grid[next + 1], grid[i + 1]]);
  }
  const geometry = own(ctx, new T.BufferGeometry());
  geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('aSurface', new T.Float32BufferAttribute(surfaces, 1));
  geometry.setIndex(indices);
  return geometry;
}

export function phoenixDeparturePoints(count) {
  const rgba = pixels(), candidates = [], width = phoenixArt.width, height = phoenixArt.height;
  for (let y = 8; y < height; y += 8) for (let x = 8; x < width; x += 8) {
    if (rgba[(y * width + x) * 4 + 3] > 200) candidates.push([x / width, y / height]);
  }
  // Cover both wings, tail, shoulders and breast even at the lowest flock LOD.
  const landmarks = [[-5, 3.8], [5, 3.8], [-1.8, -3.9], [1.6, -4.4], [-3.8, 1.7], [3.8, 1.7],
    [-2.5, .2], [2.5, .2], [-.8, -2], [.8, .6], [.1, 3.2], [-4.5, 2.8], [4.5, 2.8], [0, -4.7], [-1.4, 1], [1.4, 1]];
  const points = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const [targetX, targetY] = landmarks[i % landmarks.length];
    let closest = candidates[0], distance = Infinity;
    for (const candidate of candidates) {
      const x = (candidate[0] - .5) * WIDTH, y = (.55 - candidate[1]) * HEIGHT;
      const d = (x - targetX) ** 2 + (y - targetY) ** 2;
      if (d < distance) { distance = d; closest = candidate; }
    }
    const [u, v] = closest;
    const x = (u - .5) * WIDTH, y = (.55 - v) * HEIGHT, shape = profile(x, y);
    points.set([x, y, shape.center + shape.depth], i * 3);
  }
  return points;
}

// Distant fledglings retain the detailed painted silhouette at low cost.
export function buildPhoenixGeometry(ctx, columns = 12, rows = 14) {
  const T = ctx.THREE, positions = [], uvs = [], sides = [], parts = [], indices = [];
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
    const u = col / columns, v = row / rows, x = (u - .5) * WIDTH, y = (.55 - v) * HEIGHT;
    positions.push(x, y, 0); uvs.push(u, v); sides.push(Math.sign(x));
    parts.push(y < -.6 ? 1 : Math.abs(x) > .8 ? 0 : 2);
    if (row < rows && col < columns) {
      const i = row * (columns + 1) + col, next = i + columns + 1;
      indices.push(i, next, i + 1, next, next + 1, i + 1);
    }
  }
  const geometry = own(ctx, new T.BufferGeometry());
  geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('aSide', new T.Float32BufferAttribute(sides, 1));
  geometry.setAttribute('aPart', new T.Float32BufferAttribute(parts, 1));
  geometry.setAttribute('aFan', new T.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

// Shared artwork articulation; keep head and tail proportions unchanged in flight.
export const phoenixSkinning = `
vec3 phoenixSkin(vec3 p,float time,float flap,float sweep,float lift,float bank){
 vec3 rest=p;
 float side=sign(p.x), wing=smoothstep(.55,1.65,abs(p.x))*smoothstep(-1.7,.2,p.y);
 vec2 shoulder=vec2(.58*side,1.32);
 float span=smoothstep(.7,5.5,abs(rest.x));
 float recovery=smoothstep(-.15,.75,sin(time*3.35));
 float tuck=recovery*span*.15+max(0.0,side*bank)*span*.13;
 p.x=shoulder.x+(p.x-shoulder.x)*(1.0-tuck*wing);
 vec2 folded=turn(side*(flap-lift+side*bank*.17))*(p.xy-shoulder)+shoulder;
 p.xy=mix(p.xy,folded,wing);
 float wrist=sin(time*3.35-span*.95)*span*.24;
 vec2 depth=turn(-side*(sweep+wrist+side*bank*.24))*vec2(p.x-shoulder.x,p.z);
 p.x=mix(p.x,depth.x+shoulder.x,wing);p.z=mix(p.z,depth.y,wing);
 // Feather tips lag behind the shoulder stroke; the tail trails the climb.
 float tip=smoothstep(2.2,5.8,abs(rest.x))*wing;
 p.y+=sin(time*3.35-abs(rest.x)*.62)*tip*.22;
 p.z+=sin(time*3.35-abs(rest.x)*.8)*tip*.25;
 float tail=1.0-smoothstep(-1.7,.15,rest.y);
 float trailing=pow(clamp(-rest.y/5.8,0.0,1.0),1.4);
 p.x+=(sin(rest.y*.85-time*2.0)*.42-bank*trailing*1.1)*tail;
 p.z+=(cos(rest.y*.7-time*1.7)*.43+sin(time*2.0+rest.y*.6)*trailing*.26)*tail;
 p.y+=sin(rest.x*2.1-time*2.0)*tail*.11;
 float neck=smoothstep(2.0,3.2,p.y)*(1.0-smoothstep(.6,1.7,abs(p.x)));
 p.x+=(sin(time*1.25)*.045+bank*.16)*neck;
 p.z+=(sin(time*1.25)*.055+.08*recovery)*neck;
 return p;
}
vec3 phoenixHeroSkin(vec3 p,float time,float flap,float sweep,float lift){
 vec3 rest=p;
 float side=sign(rest.x), distance=abs(rest.x);
 float wing=smoothstep(.6,1.65,distance)*smoothstep(-1.6,.25,rest.y);
 float span=smoothstep(1.5,5.5,distance);
 float beat=time*2.65-.22*sin(time*2.65);
 float asymmetry=side*.07*sin(time*.63);
 float delayed=beat-span*.82+asymmetry;
 vec2 shoulder=vec2(.65*side,1.25);
 float recovery=smoothstep(-.25,.85,-cos(delayed));
 float wristMask=smoothstep(1.7,4.8,distance)*wing;
 vec2 wrist=vec2(2.35*side,2.0);
 float flex=(sin(delayed-.65)-sin(beat))*.18-lift*.16;
 p.xy=mix(p.xy,turn(side*flex)*(p.xy-wrist)+wrist,wristMask);
 p.x=shoulder.x+(p.x-shoulder.x)*(1.0-recovery*span*wing*.11);
 p.xy=turn(side*(flap-lift*.35+asymmetry*.15)*wing)*(p.xy-shoulder)+shoulder;
 float featherTwist=sin(delayed-.9)*span*.19;
 vec2 depth=turn(-side*(sweep+featherTwist)*wing)*vec2(p.x-shoulder.x,p.z);
 p.x=depth.x+shoulder.x;p.z=depth.y;
 float tip=smoothstep(2.5,5.7,distance)*wing;
 float featherPhase=rest.y*.85+distance*.55;
 p.y+=sin(delayed-1.1+featherPhase*.3)*tip*.17;
 p.z+=sin(delayed-1.25+featherPhase*.25)*tip*.32;
 float tail=1.0-smoothstep(-2.6,-.35,rest.y);
 float trailing=pow(clamp((-rest.y+.35)/5.5,0.0,1.0),1.35);
 float tailPhase=time*1.55+rest.y*.72;
 p.x+=(sin(tailPhase)*.52+sin(tailPhase*.61+rest.x*.65)*.16)*tail*trailing;
 p.z+=(cos(tailPhase-.65)*.62+sin(beat+rest.y*.6)*.14)*tail*trailing;
 p.y+=sin(tailPhase+rest.x*.8)*tail*trailing*.12;
 return p;
}`;

// Both the painted bird and its offspring use the same local release wave.
// The feather tips and tail lead; crown and breast linger until the last wave.
export const phoenixDissolve = `
float phoenixHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float phoenixNoise(vec2 p){
 vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
 return mix(mix(phoenixHash(i),phoenixHash(i+vec2(1,0)),f.x),mix(phoenixHash(i+vec2(0,1)),phoenixHash(i+1.0),f.x),f.y);
}
float phoenixReleaseAt(vec3 p){
 float outer=clamp(max(abs(p.x)/5.2,max(0.0,-p.y)/5.1),0.0,1.0);
 float feathers=phoenixNoise(p.xy*2.7)*.7+phoenixNoise(p.xy*8.0)*.3;
 return clamp(.025+(1.0-outer)*.73+(feathers-.5)*.10,.015,.81);
}`;

// Shared by the shell and flock arrival path: round base, gently tapered crown.
export const phoenixEggShape = `
float phoenixEggRadius(float height){
 float y=clamp(height/2.4,-1.0,1.0);
 return 1.72*sqrt(max(0.0,1.0-y*y))*(1.0-.21*y);
}`;

export function buildEggGeometry(ctx) {
  const T = ctx.THREE, rings = 48, radial = 64, positions = [], uvs = [], indices = [];
  for (let i = 0; i <= rings; i++) {
    const v = i / rings, normalizedY = -Math.cos(v * Math.PI), y = normalizedY * 2.4;
    const radius = 1.72 * Math.sin(v * Math.PI) * (1 - .21 * normalizedY);
    for (let j = 0; j <= radial; j++) {
      const angle = j / radial * TAU, x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
      positions.push(x, y, z); uvs.push(j / radial, v);
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + radial + 1;
    indices.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const geometry = own(ctx, new T.BufferGeometry());
  geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}


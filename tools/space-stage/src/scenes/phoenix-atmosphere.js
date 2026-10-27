// SPDX-License-Identifier: MIT
// Deep space and perspective star travel share the performance's frozen clock.
import { own, seed } from './factories.js';

export const phoenixAtmosphereVertex = `
varying vec2 vUv;
void main(){vUv=uv;gl_Position=vec4(position.xy,1.0,1.0);}
`;

export const phoenixAtmosphereFragment = `
uniform float uTime,uAspect,uTravel,uSpeed,uFlash,uHatch,uFine;
varying vec2 vUv;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){
 vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
 return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.0),f.x),f.y);
}
float fbm(vec2 p){
 float n=noise(p)*.53+noise(p*2.03+7.1)*.28+noise(p*4.11+13.7)*.13;
 return uFine>.5?n+noise(p*8.17+21.3)*.06:n/.94;
}
void main(){
 vec2 p=(vUv-.5)*vec2(uAspect,1.0)*18.0;
 float r=length(p),a=atan(p.y,p.x),t=uTime*.014;
 // A distant diagonal Milky Way remains visible between the passing stars.
 vec2 space=p*(1.0+uSpeed*.035*sin(r*.4-uTravel*.025));
 float warp=fbm(space*.26+vec2(t,-t*.3));
 float cloud=fbm(space*.7+warp*2.0);
 float fine=fbm(space*2.3+vec2(4.7,1.3));
 float band=exp(-pow((space.y-space.x*.3-1.6+(warp-.5)*3.0)/1.8,2.0));
 float dust=1.0-smoothstep(.36,.67,fbm(space*.9+8.0));
 float starscape=band*pow(cloud,2.0)*(.3+fine)*(.3+dust*.7);
 vec3 color=vec3(.0005,.0008,.0026);
 color+=mix(vec3(.025,.036,.08),vec3(.06,.025,.075),smoothstep(-8.0,10.0,p.x))*starscape;
 color+=vec3(.003,.009,.025)*exp(-r*r*.025)*cloud;
 // Faint curved filaments bend around the vanishing point during acceleration.
 float spiral=a*3.0+log(1.0+r)*7.5-uTravel*.035+warp*2.3;
 float filament=pow(.5+.5*sin(spiral),28.0);
 float outer=smoothstep(3.8,7.0,r)*(1.0-smoothstep(10.0,16.0,r));
 color+=vec3(.014,.038,.072)*filament*outer*cloud*uSpeed*.6;
 color+=vec3(.003,.012,.025)*exp(-r*r*.07)*uSpeed;
 // The rebirth lights the surrounding space briefly, then the stars return.
 float wave=exp(-pow((r-(2.0+(1.0-uHatch)*11.0))/.3,2.0))*uHatch;
 color+=vec3(.26,.07,.014)*wave;
 color+=vec3(.045,.013,.003)*uFlash*exp(-r*r*.045);
 color*=1.0-smoothstep(.3,.85,length(vUv-.5))*.55;
 gl_FragColor=vec4(color,1.0);
 #include <colorspace_fragment>
}`;

const starVertex = `
attribute vec4 aStar;
attribute float aEnd;
uniform float uTravel,uSpeed,uTime,uHeight,uPixel;
varying vec3 vColor;
varying float vAlpha;
void main(){
 // Integrating travel avoids position jumps as the flight slows into an egg.
 float head=14.0-mod(aStar.z*110.0-uTravel*(.65+aStar.w*.7),110.0);
 float tailLength=.08+uSpeed*(5.0+aStar.w*13.0);
 float z=head-aEnd*tailLength;
 float angle=aStar.x+sin(uTravel*.009)*.055+z*.0025*uSpeed;
 vec3 p=vec3(cos(angle)*aStar.y,sin(angle)*aStar.y+1.1,z);
 p.xy+=vec2(sin(uTime*.42),sin(uTime*.62))*.4;
 vec4 mv=modelViewMatrix*vec4(p,1.0);
 gl_Position=projectionMatrix*mv;
 float nearFade=1.0-smoothstep(9.0,14.0,head);
 float farFade=smoothstep(-96.0,-70.0,head);
 vec3 blue=mix(vec3(.2,.42,.85),vec3(.8,.9,1.0),aStar.w);
 vColor=mix(blue,vec3(1.0,.7,.32),step(.94,aStar.w));
 vAlpha=nearFade*farFade*(.22+aStar.w*.65);
 #ifdef STREAK
 vAlpha*=uSpeed*(1.0-aEnd*.95);
 #else
 vAlpha*=.8;
 gl_PointSize=clamp(uPixel*uHeight*(.065+aStar.w*.13)/max(3.0,-mv.z),1.0,3.8);
 #endif
}`;

const starFragment = `
varying vec3 vColor;varying float vAlpha;
void main(){
 float alpha=vAlpha;
 #ifndef STREAK
 float d=length(gl_PointCoord-.5);if(d>.5)discard;
 alpha*=exp(-d*d*24.0);
 #endif
 gl_FragColor=vec4(vColor,alpha);
 #include <colorspace_fragment>
}`;

export function createPhoenixStarTravel(ctx, parent, uniforms) {
  const T = ctx.THREE, count = 1000;
  function geometry(lines) {
    const positions = [], stars = [], ends = [];
    for (let i = 0; i < count; i++) {
      const angle = seed(i, 51) * Math.PI * 2, radius = 3.4 + Math.sqrt(seed(i, 52)) * 25;
      for (let end = 0; end < (lines ? 2 : 1); end++) {
        positions.push(0, 0, 0); stars.push(angle, radius, seed(i, 53), seed(i, 54)); ends.push(end);
      }
    }
    const g = own(ctx, new T.BufferGeometry());
    g.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
    g.setAttribute('aStar', new T.Float32BufferAttribute(stars, 4));
    g.setAttribute('aEnd', new T.Float32BufferAttribute(ends, 1));
    return g;
  }
  const lines = new T.LineSegments(geometry(true), own(ctx, new T.ShaderMaterial({ uniforms,
    vertexShader: starVertex, fragmentShader: starFragment, defines: { STREAK: 1 },
    transparent: true, depthWrite: false, blending: T.AdditiveBlending })));
  const heads = new T.Points(geometry(false), own(ctx, new T.ShaderMaterial({ uniforms,
    vertexShader: starVertex, fragmentShader: starFragment,
    transparent: true, depthWrite: false, blending: T.AdditiveBlending })));
  lines.name = 'phoenix-star-streaks'; heads.name = 'phoenix-travel-stars';
  for (const mesh of [lines, heads]) { mesh.frustumCulled = false; mesh.renderOrder = -7; parent.add(mesh); }
  return {
    setDensity(fraction) {
      const visible = Math.max(1, Math.min(count, Math.floor(count * fraction)));
      lines.geometry.setDrawRange(0, visible * 2); heads.geometry.setDrawRange(0, visible);
    }
  };
}

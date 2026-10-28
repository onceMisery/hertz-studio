// SPDX-License-Identifier: MIT
// 凤凰涅槃: a centered reference phoenix slowly releases fledglings into the
// shell, and release the same phoenix rig as the egg cracks and its wings unfold.
import { basicInstance, own, qualityDensity, root, seed } from './factories.js';
import { createParticlePointer, particleNoiseShader } from './particle-pointer.js';
import { approach, createGlow, createShockPool, createStarfield, faceCamera, TAU } from './scene-field.js';
import { createPhoenixArtwork, buildPhoenixReference, buildPhoenixGeometry, phoenixDeparturePoints, phoenixSkinning, phoenixDissolve, phoenixEggShape, buildEggGeometry } from './phoenix-form.js';
import { phoenixAtmosphereVertex, phoenixAtmosphereFragment, createPhoenixStarTravel, createPhoenixSanctum } from './phoenix-atmosphere.js';

const PHOENIXES = 16, DUST = 15000, TRAILS = 760, SHARDS = 120;
const NEST = [0, .9, .2];
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function phoenixTimeline(time, mode = 'auto') {
  if (mode === 'flight') return { flight: 1, swarm: 0, gather: 0, egg: 0, flash: 0 };
  if (mode === 'swarm') return { flight: 0, swarm: 1, gather: 0, egg: 0, flash: 0 };
  if (mode === 'egg') return { flight: 0, swarm: 0, gather: 1, egg: 1, flash: 0 };
  if (mode === 'rebirth') return { flight: 1, swarm: 0, gather: 0, egg: 0, flash: 1 };
  const t = ((time % 36) + 36) % 36;
  return {
    flight: 1 - smooth(6, 16, t) + smooth(31.2, 34.5, t),
    swarm: smooth(6, 16, t) * (1 - smooth(24, 26.5, t)),
    gather: smooth(18, 25.5, t) * (1 - smooth(32.5, 34.5, t)),
    egg: smooth(23, 26.5, t) * (1 - smooth(31, 33, t)),
    flash: Math.exp(-Math.pow((t - 31.8) * 1.5, 2))
  };
}

const shelf = `
const float TAU=6.283185307;
mat2 turn(float a){return mat2(cos(a),-sin(a),sin(a),cos(a));}
`;

// Shared with the hero rig: flock origins remain attached to its animated pose.
const swarmMotion = `
uniform float uTime,uSwarm,uGather,uEgg,uBass,uMid,uTreble,uResponse,uCharge,uBurst,uStir,uScatter,uFlap,uSweep,uWingLift;
uniform mat4 uHeroMatrix;
uniform vec3 uPointer; uniform float uPointerAmount;
${shelf}
${phoenixSkinning}
${phoenixDissolve}
${phoenixEggShape}
vec3 attachedHome(vec3 p){
 return (uHeroMatrix*vec4(phoenixHeroSkin(p,uTime,uFlap,uSweep,uWingLift),1.0)).xyz;
}
`;

const wingVertex = `
attribute vec2 aFan; attribute float aSide,aPart;
attribute vec4 aFlight; attribute vec3 aHome,aPerch;
varying vec2 vFan,vUv; varying vec3 vLocal; varying float vLight,vOpacity,vTint,vPart;
${swarmMotion}
#ifdef EMBERS
attribute float aEmber; uniform float uPixel,uHeight; varying float vLife;
#endif
void main(){
 vFan=aFan; vUv=uv; vLocal=position; vPart=aPart;
 float id=aFlight.x, phase=uTime*(2.8+aFlight.y*.8)+id*TAU;
 // Outer feathers release first, followed by the shoulder and breast.
 float birth=phoenixReleaseAt(aHome);
 float release=smoothstep(birth-.025,birth+.22,uScatter);
 float absorbed=smoothstep(.65+aFlight.y*.19,.81+aFlight.y*.19,uGather);
 vec3 p=phoenixSkin(position,uTime,sin(phase)*.29,sin(phase-.4)*.34,0.0,0.0);
 #ifdef FLAMES
 p.xy*=1.008;
 #endif
 // Each fledgling drifts outward from its own feather, without crossing
 // the large bird to reach an unrelated orbit on the other side.
 float theta=atan(aPerch.y-.9,aPerch.x);
 vec3 drift=aPerch;
 drift.xy+=vec2(sin(uTime*.24+id*TAU),cos(uTime*.19+id*TAU))*.25;
 float phi=acos(clamp(1.0-2.0*aFlight.z,-.98,.98));
 float shellAngle=theta+uGather*TAU*1.1+uStir*.45;
 float shellY=cos(phi)*2.4, shellR=phoenixEggRadius(shellY);
 vec3 shell=vec3(cos(shellAngle)*shellR,shellY,sin(shellAngle)*shellR)*1.16+vec3(0.0,.9,.2);
 vec3 destination=mix(drift,shell,smoothstep(0.0,.9,uGather));
 vec3 attraction=uPointer-destination;
 destination+=attraction*uPointerAmount*.12*exp(-dot(attraction,attraction)*.04)*(1.0-uGather);
 destination+=normalize(destination-uPointer+vec3(.001))*uBurst*.6*(1.0-uGather);
 float size=(.115+pow(aFlight.w,2.0)*.065)*mix(.08,1.0,smoothstep(0.0,.8,release))*(1.0-absorbed*.92);
 p*=size;
 // Upright birds bank into their paths; the crown and streaming tail stay legible.
 float bank=sin(theta)*.12+sin(phase*.3)*.06;
 p.xy=turn(bank+uGather*.4)*p.xy;
 p+=mix(attachedHome(aHome),destination,release);
 p.y+=sin(release*3.14159265)*.55;
 p.z+=sin(release*3.14159265)*.4;
 #ifdef EMBERS
 vLife=fract(uTime*(.6+aFlight.y*.28)+id*19.0+aEmber);
 p+=vec3(sin(vLife*5.0+id*17.0)*.18,-vLife*1.4,.12)*size*7.0;
 #endif
 vOpacity=smoothstep(0.0,.24,release)*(1.0-absorbed)*(.8+aFlight.w*.2);
 vTint=aFlight.z;vLight=.85+.15*cos(phase);
 vec4 mv=modelViewMatrix*vec4(p,1.0);gl_Position=projectionMatrix*mv;
 #ifdef EMBERS
 gl_PointSize=clamp(uPixel*uHeight*.026/max(2.0,-mv.z)*(1.0-vLife*.55),1.5,4.5);
 #endif
}`;

const artworkSampling = `
uniform sampler2D uArtwork;
uniform float uTime;
varying vec2 vUv;
vec4 artwork(){
 vec2 flow=vec2(sin(vUv.y*32.0-uTime*2.6),cos(vUv.x*29.0-uTime*2.1))*.0007;
 return texture2D(uArtwork,vUv+flow);
}
float fireEdge(float alpha){
 vec2 d=vec2(.0025,0.0);
 float surrounding=min(min(texture2D(uArtwork,vUv+d).a,texture2D(uArtwork,vUv-d).a),
  min(texture2D(uArtwork,vUv+d.yx).a,texture2D(uArtwork,vUv-d.yx).a));
 return alpha*(1.0-surrounding);
}`;

const wingFragment = artworkSampling + `
uniform float uTreble,uResponse;
varying float vOpacity,vLight;
void main(){
 vec4 art=artwork();if(art.a<.012 || vOpacity<.008)discard;
 gl_FragColor=vec4(art.rgb*(.94+uTreble*uResponse*.22),art.a*vOpacity);
 #include <colorspace_fragment>
}`;
const flameFragment = artworkSampling + `
uniform float uFire,uBurst;
varying float vOpacity;
void main(){
 vec4 art=artwork();float hot=max(art.r-art.b,0.0);
 float shimmer=.6+.4*sin(vUv.y*53.0-uTime*4.0);
 float alpha=(fireEdge(art.a)*.7+art.a*hot*.13)*shimmer*vOpacity*uFire;
 if(alpha<.006)discard;
 gl_FragColor=vec4(vec3(1.4,.3,.012),alpha);
 #include <colorspace_fragment>
}`;

const emberFragment = `
uniform float uFire,uBurst; varying float vLife,vOpacity;
void main(){
 float d=length(gl_PointCoord-.5);if(d>.5)discard;
 float fade=smoothstep(0.0,.12,vLife)*(1.0-smoothstep(.3,1.0,vLife));
 vec3 color=mix(vec3(2.4,1.3,.32),vec3(1.1,.09,.003),vLife);
 gl_FragColor=vec4(color,exp(-d*d*16.0)*fade*(uFire+uBurst*.7)*vOpacity*1.2);
 #include <colorspace_fragment>
}`;

// The approved reference painting covers the complete bird throughout flight
// and rebirth. Never replace it with repeated individual feather tiles.
const heroVertex = `
uniform float uTime,uFlap,uSweep,uWingLift,uPointerAmount;
uniform vec3 uPointer;
attribute float aSurface;
varying vec2 vUv;varying vec3 vLocal,vViewPosition;varying float vSurface;
${shelf}
${phoenixSkinning}
void main(){
 vUv=uv;vLocal=position;vSurface=aSurface;
 vec3 p=phoenixHeroSkin(position,uTime,uFlap,uSweep,uWingLift);
 p.xy+=uPointer.xy*uPointerAmount*.025*smoothstep(.6,5.0,abs(position.x));
 vec4 mv=modelViewMatrix*vec4(p,1.0);vViewPosition=mv.xyz;
 gl_Position=projectionMatrix*mv;
}`;
const heroFragment = artworkSampling + `
uniform float uHero,uDissolve,uFlash,uBass,uResponse;
varying vec3 vLocal,vViewPosition;varying float vSurface;
${phoenixDissolve}
void main(){
 vec4 art=artwork();
 float edge=1.0-abs(vSurface);
 if(art.a<.008&&edge<.5)discard;
 float releaseAt=phoenixReleaseAt(vLocal);
 float remaining=1.0-smoothstep(releaseAt,releaseAt+.22,uDissolve);
 if(remaining<.004)discard;
 float fire=fireEdge(art.a);
 float ember=sin(remaining*3.14159265)*step(.001,uDissolve);
 vec3 color=art.rgb*(1.0+uBass*uResponse*.14+uFlash*.18);
 float alpha=mix(smoothstep(.04,.5,art.a),1.0,edge)*uHero*remaining;
 #ifdef ART_FLAME
 float shimmer=.65+.35*sin(vUv.y*57.0-uTime*4.0);
 color=vec3(1.5,.24,.008);
 alpha*=fire*shimmer*.32;
 #else
 vec3 n=normalize(cross(dFdx(vViewPosition),dFdy(vViewPosition)));
 vec3 view=normalize(-vViewPosition);
 float key=max(0.0,dot(n,normalize(vec3(-.65,.9,.75))));
 float rim=pow(1.0-abs(dot(n,view)),2.1);
 float fill=max(0.0,dot(n,normalize(vec3(.8,.15,-.6))));
 float back=1.0-smoothstep(-.7,.1,vSurface);
 color*=mix(vec3(.58)+vec3(.48,.43,.35)*key,vec3(.46,.34,.24)+key*.44,back);
 color+=vec3(.18,.24,.26)*fill*rim+vec3(.48,.19,.035)*rim;
 color=mix(color,max(color,vec3(.48,.075,.008)),edge*.65);
 color+=vec3(.65,.12,.006)*ember;
 #endif
 if(alpha<.006)discard;
 gl_FragColor=vec4(color,alpha);
 #include <colorspace_fragment>
}`;

// Egg, eclipse and rebirth effects are independent of the phoenix artwork.
const eggVertex = `
varying vec3 vPos,vNormalV,vView; varying vec2 vUv;
uniform float uTime,uBass,uResponse,uEgg,uFlash,uHatch;
void main(){
 vPos=position; vUv=uv;
 vec3 p=position*(1.0+uBass*uResponse*.02+uFlash*.06+uHatch*.08);
 p.y+=sin(uTime*1.3+position.y*2.0)*.01;
 vNormalV=normalize(normalMatrix*normal);
 vec4 mv=modelViewMatrix*vec4(p,1.0);
 vView=normalize(-mv.xyz);
 gl_Position=projectionMatrix*mv;
}`;

const eggFragment = `
uniform float uTime,uEgg,uFlash,uBass,uResponse,uCharge,uCrack,uStrikeAge,uHatch,uStir;
uniform vec3 uStrike;
varying vec3 vPos,vNormalV,vView; varying vec2 vUv;
float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
 return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
  mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){return noise(p)*.58+noise(p*2.03+4.7)*.27+noise(p*4.1+9.2)*.15;}
// Stable shell plates: the gaps open with heat instead of sliding over the egg.
float fissure(vec2 uv){
 vec2 grid=uv*vec2(12.0,8.0),cell=floor(grid),local=fract(grid);
 float first=9.0,second=9.0;
 for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
  vec2 offset=vec2(float(x),float(y)),id=cell+offset;
  id.x=mod(id.x,12.0);
  vec2 jitter=vec2(hash(vec3(id,1.7)),hash(vec3(id,5.3)));
  vec2 delta=offset+.2+jitter*.6-local;
  float d=dot(delta,delta);
  if(d<first){second=first;first=d;}else{second=min(second,d);}
 }
 return sqrt(second)-sqrt(first);
}
void main(){
 vec3 normal=normalize(vNormalV),view=normalize(vView);
 vec3 light=normalize(vec3(-.6,.85,1.2));
 float diffuse=max(0.0,dot(normal,light));
 float fres=pow(max(0.0,1.0-abs(dot(normal,view))),2.2);
 float a=atan(vPos.z,vPos.x);
 float row=vUv.y*22.0,cell=fract(vUv.x*28.0+floor(row)*.5)-.5;
 float feather=abs(fract(row)-(.18+cell*cell*2.1));
 float engraving=exp(-feather*38.0)*smoothstep(.0,.2,vUv.y)*(1.0-smoothstep(.87,1.0,vUv.y));
 float grain=fbm(vPos*7.0);
 float gap=fissure(vUv);
 float width=.009+uCrack*.025;
 float seam=1.0-smoothstep(width,width+.012,gap);
 float warm=exp(-gap*12.0);
 float strike=exp(-pow(length(vPos-uStrike)/1.3,2.0))*exp(-uStrikeAge*2.4);
 float pulse=.65+.35*sin(uTime*2.4+vPos.y*.6);
 vec3 shell=mix(vec3(.085,.009,.004),vec3(.34,.09,.018),grain);
 vec3 color=shell*(.22+diffuse*.95);
 color+=vec3(.65,.27,.055)*engraving*(.1+diffuse*.32);
 float specular=pow(max(0.0,dot(normal,normalize(light+view))),24.0);
 color+=vec3(.9,.45,.15)*specular*.5;
 color+=vec3(1.0,.055,.002)*warm*(.12+uCrack*.26);
 color+=mix(vec3(1.6,.26,.012),vec3(3.0,1.45,.28),uCrack)*seam*(.4+uCrack*.8)*pulse;
 color+=vec3(2.0,.5,.025)*strike;
 color+=vec3(1.2,.27,.018)*fres*(.18+uCharge*.25);
 color+=vec3(2.4,1.1,.2)*uFlash*(.12+seam*.5)+vec3(1.7,.65,.07)*uHatch*.32;
 float deposit=.12+.66*noise(vPos*5.0);
 float shellMask=smoothstep(deposit,deposit+.2,uEgg);
 float alpha=shellMask*(1.0-smoothstep(0.0,.55,uHatch));
 if(alpha<.01)discard;
 gl_FragColor=vec4(color,alpha);
 #include <colorspace_fragment>
}`;

const eclipseFragment = `
uniform float uTime,uRing,uFlash,uBass,uResponse,uCharge;
varying vec2 vUv;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.0),f.x),f.y);}
void main(){
 vec2 p=(vUv-.5)*9.0;float r=length(p),a=atan(p.y,p.x);
 float n=noise(vec2(a*10.0,r*3.0-uTime*.9));
 float fine=noise(vec2(a*27.0+n*2.0,r*9.0-uTime*2.0));
 float rim=exp(-pow((r-2.65)/.032,2.0));
 float glow=exp(-abs(r-2.65)*7.0)*.32;
 float flame=smoothstep(2.64,2.74,r)*(1.0-smoothstep(2.72+n*.7+fine*.3,3.0+n*.75+fine*.4,r));
 flame*=pow(fine,.7)*(.4+.6*n);
 vec3 fire=mix(vec3(.9,.035,.001),vec3(2.1,.65,.025),clamp(flame+glow,0.0,1.0));
 vec3 color=fire*(flame*.9+glow)+vec3(2.5,1.2,.21)*rim;
 float alpha=(rim+glow+flame*.8)*uRing*(1.0+uFlash*.2);
 if(alpha<.006)discard;
 gl_FragColor=vec4(color,alpha);
 #include <colorspace_fragment>
}`;

const runesFragment = `
uniform float uTime,uRunes,uFlash,uStir;
varying vec2 vUv;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
void main(){
 vec2 p=(vUv-.5)*14.0;
 float r=length(p), a=atan(p.y,p.x)+uTime*.018+uStir*.035;
 float band=smoothstep(4.78,4.85,r)*(1.0-smoothstep(5.34,5.4,r));
 float inner=exp(-pow((r-4.7)/.022,2.0));
 float outer=exp(-pow((r-5.44)/.022,2.0));
 float mid=exp(-pow((r-5.07)/.018,2.0))*.32;
 float angle=a/6.2831853*40.0;
 float id=floor(angle), f=fract(angle);
 float h1=hash(vec2(id,7.1)), h2=hash(vec2(id,2.3));
 float v=(r-4.82)/.5;
 float vertical=smoothstep(.34,.38,f)*(1.0-smoothstep(.44,.48,f))*smoothstep(.18,.24,v)*(1.0-smoothstep(.74,.8,v));
 float horizontal=smoothstep(.18,.22,f)*(1.0-smoothstep(.66,.7,f))*smoothstep(.42,.46,v)*(1.0-smoothstep(.52,.56,v));
 float dotGlyph=1.0-smoothstep(.04,.075,length(vec2((f-.5)*1.15,(v-.5)*.85)));
 float glyph=(vertical*step(.55,h1)+horizontal*step(.3,h1)*(1.0-step(.55,h1))+dotGlyph*(1.0-step(.3,h1)))*step(.3,h2)*band;
 float ticks=pow(.5+.5*cos(a*120.0),14.0)*band*.22;
 float diamonds=pow(.5+.5*cos(a*4.0+1.5707963),20.0)*exp(-pow((r-5.1)/.11,2.0));
 vec3 color=mix(vec3(1.1,.56,.1),vec3(1.65,.95,.28),glyph*.6);
 float alpha=(glyph*1.15+inner*.36+outer*.38+mid+ticks*1.2+diamonds*.8)*uRunes*(.9+uFlash*.8);
 if(alpha<.006)discard;
 gl_FragColor=vec4(color,alpha);
 #include <colorspace_fragment>
}`;

const ritualFragment = `
uniform float uTime,uRitual,uCharge,uStir,uStrikes;
varying vec2 vUv;
void main(){
 vec2 p=(vUv-.5)*9.0;
 float r=length(p), a=atan(p.y,p.x);
 float rings=exp(-pow((r-2.85)/.022,2.0))+exp(-pow((r-3.05)/.015,2.0))*.7+exp(-pow((r-3.3)/.01,2.0))*.4;
 float ticks=pow(.5+.5*cos(a*36.0+uTime*.4+uStir),14.0)*exp(-pow((r-3.18)/.16,2.0));
 float arc=pow(.5+.5*cos(a*3.0-uTime*.12),24.0)*exp(-pow((r-3.6)/.035,2.0));
 float prog=fract((a-1.5707963)/6.2831853);
 float meter=step(prog,uCharge)*exp(-pow((r-3.74)/.032,2.0));
 float pips=0.0;
 for(int i=0;i<3;i++){
  float pa=1.5707963+float(i)*2.0943951;
  float d=length(p-vec2(cos(pa),sin(pa))*3.98);
  pips+=exp(-pow(d/.075,2.0))*(.24+.95*step(float(i)+.5,uStrikes));
 }
 float alpha=(rings*.55+ticks*.7+arc*.45+meter*.95+pips*.65)*uRitual*(.4+uCharge*.8);
 vec3 color=mix(vec3(1.7,.8,.16),vec3(2.6,1.7,.5),uCharge);
 color+=vec3(2.0,1.1,.22)*meter*.8;
 if(alpha<.006)discard;
 gl_FragColor=vec4(color,alpha);
 #include <colorspace_fragment>
}`;

// A fire aura that hugs the shell silhouette.
const eggFireFragment = `
uniform float uTime,uEgg,uCharge,uHatch,uBass,uResponse;
varying vec3 vPos,vNormalV,vView; varying vec2 vUv;
float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
 return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
  mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
void main(){
 vec3 n=normalize(vNormalV), v=normalize(vView);
 float fres=pow(max(0.0,1.0-abs(dot(n,v))),1.5);
 float a=atan(vPos.z,vPos.x);
 float streak=noise(vec3(a*3.0,vPos.y*2.2-uTime*1.2,1.0));
 float flame=pow(.5+.5*cos(a*11.0+vPos.y*5.0-uTime*2.7+streak*4.0),3.0);
 float tips=pow(.5+.5*cos(a*23.0-vPos.y*9.0-uTime*3.6+streak*7.0),5.0);
 vec3 color=mix(vec3(1.25,.05,.003),vec3(2.9,1.5,.28),flame*.75+tips*.45);
 float alpha=fres*(.17+flame*.15+tips*.09)*(1.0+uCharge*.5)*(1.0-smoothstep(.12,.72,uHatch))*uEgg;
 if(alpha<.008)discard;
 gl_FragColor=vec4(color,alpha);
 #include <colorspace_fragment>
}`;

// Orbital fire ribbons around the egg.
const fireRingFragment = `
uniform float uTime,uEgg,uCharge,uHatch;
varying vec2 vUv;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.0),f.x),f.y);}
void main(){
 float a=vUv.x*6.2831853;
 float n=noise(vec2(vUv.x*19.0,uTime*1.7));
 float tongues=pow(.5+.5*cos(a*7.0+uTime*1.9+n*5.0),2.0);
 float sparks=pow(.5+.5*cos(a*33.0-uTime*2.6+n*3.0),8.0);
 vec3 color=mix(vec3(1.5,.14,.004),vec3(2.9,1.5,.32),tongues);
 float alpha=(.3+n*.32+sparks*.45)*(1.0+uCharge*.8)*(1.0-smoothstep(.08,.6,uHatch))*uEgg;
 if(alpha<.008)discard;
 gl_FragColor=vec4(color,alpha*.72);
 #include <colorspace_fragment>
}`;

// A wall of fire spiralling around the egg. Two counter-rotating shells make
// the ritual read as a vortex instead of a static ring.
const vortexFragment = `
uniform float uTime,uEgg,uCharge,uHatch,uStir;
varying vec2 vUv;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.0),f.x),f.y);}
void main(){
 float a=vUv.x*6.2831853, h=vUv.y;
 float drift=uTime*(1.15+uCharge*.9)+uStir*.25;
 float n=noise(vec2(vUv.x*11.0,h*5.0-drift));
 float tongues=pow(.5+.5*cos(a*12.0+n*5.0+h*10.0-drift*2.2),3.0);
 float n2=noise(vec2(vUv.x*27.0-uTime*.5,h*11.0-drift*2.0));
 float licks=pow(.5+.5*cos(a*31.0+n2*7.0+h*26.0),7.0);
 float band=smoothstep(.0,.12,h)*(1.0-smoothstep(.7,1.0,h));
 float alpha=(tongues*.6+licks*.42)*band*(.14+uCharge*.3)*(1.0-smoothstep(.1,.75,uHatch))*uEgg;
 vec3 color=mix(vec3(1.35,.075,.003),vec3(3.0,1.55,.28),tongues*.65+licks*.35);
 if(alpha<.006)discard;
 gl_FragColor=vec4(color,alpha);
 #include <colorspace_fragment>
}`;

const shardVertex = `
attribute vec3 aDir; attribute float aShard;
uniform float uShardAge,uShardPower,uTime;
varying float vLife;
void main(){
 float age=uShardAge, spin=aShard*6.2831853*3.0+age*8.0;
 vec3 p=position;
 p.xz=mat2(cos(spin),-sin(spin),sin(spin),cos(spin))*p.xz;
 p.xy=mat2(cos(spin*.7),-sin(spin*.7),sin(spin*.7),cos(spin*.7))*p.xy;
 vec3 center=vec3(0.0,.9,.2)+aDir*(2.4+aShard*4.0)*age*uShardPower+vec3(0.0,-1.6*age*age,0.0);
 vec4 mv=modelViewMatrix*vec4(p+center,1.0);
 gl_Position=projectionMatrix*mv;
 vLife=age;
}`;

const shardFragment = `
uniform float uShardPower;
varying float vLife;
void main(){
 float fade=(1.0-smoothstep(.35,1.1,vLife))*(1.0-smoothstep(.8,1.05,vLife));
 vec3 color=mix(vec3(2.6,1.5,.35),vec3(1.2,.08,.004),vLife);
 gl_FragColor=vec4(color,fade*.85);
 #include <colorspace_fragment>
}`;

const dustVertex = `
attribute vec4 aDust; attribute float aTrail;
uniform float uPixel,uHeight,uSize; varying vec3 vColor; varying float vAlpha;
${particleNoiseShader}
uniform float uTime,uSwarm,uGather,uEgg,uBass,uTreble,uResponse,uBurst,uStir,uFlash;
uniform vec3 uPointer; uniform float uPointerAmount;
void main(){
 float raw=.2+pow(aDust.x,.68)*12.0;
 float arm=floor(aDust.y*3.0), lane=fract(aDust.y*3.0)-.5;
 float a=arm*2.0944+log(1.0+raw)*3.0-uTime*(.15+.95/(1.6+raw))+lane*(.14+raw*.02);
 a+=particleNoise(vec3(raw*.8,arm*7.0,uTime*.06))*.1+uStir*(.4+1.2/(1.0+raw));
 #ifdef TRAILS
 a-=aTrail*(.006+aDust.w*.014);
 #endif
 vec3 spiral=vec3(cos(a)*raw,sin(a)*raw*.8+.9+lane*.2,-3.5-raw*.28+(aDust.z-.5)*(.7+raw*.09));
 spiral.xy+=vec2(sin(raw*2.0+a*3.0),cos(raw*1.6-a*2.0))*(.06+.1*uGather);
 vec3 idle=position;
 idle.y=mod(position.y+10.5+uTime*(.35+aDust.w*.8),21.0)-10.5;
 idle.x+=sin(idle.y*.35+uTime*.28+aDust.w*20.0)*(.2+aDust.w*.3);
 vec3 p=mix(idle,spiral,uGather);
 p.xy+=uPointer.xy*uPointerAmount*.015;
 p.xy*=1.0+uBass*uResponse*.02+uBurst*.02;
 vec4 mv=modelViewMatrix*vec4(p,1.0);gl_Position=projectionMatrix*mv;
 vec3 baseColor=mix(vec3(.98,.3,.12),vec3(.72,.16,.08),smoothstep(.8,6.0,raw));
 baseColor=mix(baseColor,vec3(1.0,.75,.35),aDust.w*.5);
 vColor=baseColor;
 float tw=.66+.34*sin(uTime*.62+aDust.w*80.0);
 float sparks=.025+smoothstep(.83,.97,aDust.w)*.35;
 vAlpha=mix(sparks,uGather*(.5+aDust.w*.7),uGather)*tw*(1.0-smoothstep(9.5,12.5,raw))*(1.0+uFlash*.3);
 #ifdef TRAILS
 vAlpha*=uGather*.3*(1.0-aTrail*.6);
 #endif
 gl_PointSize=clamp((.6+aDust.w*1.6)*uPixel*uHeight*.05/max(2.0,-mv.z)*uSize*(1.0+uTreble*uResponse*.2),1.0,4.4);
}`;
const dustFragment = `varying vec3 vColor; varying float vAlpha;
void main(){
 #ifndef TRAILS
 float d=length(gl_PointCoord-.5);if(d>.5)discard;
 float alpha=exp(-d*d*25.0)*(1.0-smoothstep(.3,.5,d))*vAlpha;
 #else
 float alpha=vAlpha;
 #endif
 gl_FragColor=vec4(vColor,alpha);
 #include <colorspace_fragment>
}`;

const veilFragment = `
uniform float uTime,uGather,uEgg,uBass,uResponse,uFlash,uFine,uStir; varying vec2 vUv;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.0),f.x),f.y);}
float fbm(vec2 p){float n=noise(p)*.57+noise(p*2.03+4.7)*.28;return uFine>.5?n+noise(p*4.13+9.2)*.15:n/.85;}
void main(){
 vec2 p=(vUv-.5)*24.0;float r=length(p),a=atan(p.y,p.x),t=uTime*.15;
 float turbulence=fbm(p*1.3+vec2(t*.22,-t*.28))*1.4;
 float spiral=a*3.0-log(1.0+r)*13.0+t*4.2+uStir*1.6+turbulence;
 float ridge=pow(.5+.5*cos(spiral),11.0);
 float filament=pow(.5+.5*cos(spiral+fbm(p*1.5)*2.3),22.0);
 float cloud=fbm(p*1.8+vec2(t*.25,-t*.2));
 float lanes=exp(-pow((r-2.1)/.2,2.0))+.6*exp(-pow((r-4.3)/.24,2.0));
 float alpha=(cloud*.025+(ridge*.38+filament*.24)*cloud*uGather+lanes*(.05+uBass*uResponse*.04)*uGather);
 alpha*=smoothstep(.16,.75,r)*(1.0-smoothstep(5.2,10.8,r))*(1.0+uFlash*.6)*(1.0+uEgg*.25);
 vec3 color=mix(vec3(.7,.025,.004),vec3(.9,.24,.025),smoothstep(.4,4.2,r));
 color*=1.0+uBass*uResponse*.2+uFlash*.3;
 gl_FragColor=vec4(color,alpha);
 #include <colorspace_fragment>
}`;


export function createPhoenixVortex(ctx) {
  const T = ctx.THREE, group = root(ctx), world = new T.Group(); group.add(world);
  const pointer = createParticlePointer(ctx, world, { depth: 0, radius: 3 });
  const uniforms = { ...pointer.uniforms,
    uArtwork: { value: createPhoenixArtwork(ctx) }, uHeroMatrix: { value: new T.Matrix4() }, uScatter: { value: 0 }, uDissolve: { value: 0 },
    uTime: { value: 0 }, uFlight: { value: 0 }, uSwarm: { value: 0 }, uGather: { value: 0 }, uEgg: { value: 0 }, uFlash: { value: 0 },
    uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 }, uResponse: { value: .7 },
    uCharge: { value: 0 }, uBurst: { value: 0 }, uStir: { value: 0 }, uFire: { value: 0 }, uRing: { value: 0 }, uRunes: { value: 0 },
    uRitual: { value: 0 }, uPixel: { value: 1 }, uHeight: { value: 720 }, uAspect: { value: 16 / 9 }, uSize: { value: 1 }, uFine: { value: 1 },
    uHero: { value: 0 }, uGhost: { value: 0 }, uCrack: { value: 0 }, uHatch: { value: 0 },
    uStrike: { value: new T.Vector3(0, 1, 1) }, uStrikeAge: { value: 10 },
    uShardAge: { value: 10 }, uShardPower: { value: 1 }, uSpeed: { value: 0 }, uTravel: { value: 0 },
    uFlap: { value: 0 }, uSweep: { value: 0 }, uWingLift: { value: .02 }, uStrikes: { value: 0 } };

  const hero = new T.Group(); hero.name = 'phoenix-hero'; hero.position.set(0, .55, .3); hero.scale.setScalar(1); world.add(hero);
  const nestPosition = new T.Vector3(...NEST);
  const heroGeometry = buildPhoenixReference(ctx);
  const artworkMaterial = own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: heroVertex, fragmentShader: heroFragment,
    side: T.FrontSide, transparent: true, depthWrite: true }));
  const heroSkin = new T.Mesh(heroGeometry, artworkMaterial);
  heroSkin.name = 'phoenix-reference-skin'; heroSkin.frustumCulled = false; heroSkin.renderOrder = 3; hero.add(heroSkin);
  const heroFire = new T.Mesh(heroGeometry, own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: heroVertex, fragmentShader: heroFragment,
    defines: { ART_FLAME: 1 }, side: T.DoubleSide, forceSinglePass: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending })));
  heroFire.name = 'phoenix-reference-fire'; heroFire.frustumCulled = false; heroFire.renderOrder = 4; hero.add(heroFire);

  // Flock ------------------------------------------------------------------
  const swarmGeometry = buildPhoenixGeometry(ctx, 12, 14), flights = new Float32Array(PHOENIXES * 4);
  const homes = phoenixDeparturePoints(PHOENIXES);
  const perches = new Float32Array(PHOENIXES * 3);
  const spread = [[-7, 4], [7, 4], [-3, -4], [3, -4], [-7, 0], [7, 0], [-4, 1.5], [4, 1.5],
    [-4, -1.8], [4, -1.8], [0, 4.7], [-4.5, 4], [4.5, 4], [0, -4.5], [-1.8, 1], [1.8, 1]];
  for (let i = 0; i < PHOENIXES; i++) perches.set([...spread[i], (seed(i, 3) - .5) * 2.8 - .6], i * 3);
  // Golden-angle spacing stays even at every quality level, avoiding clusters.
  for (let i = 0; i < PHOENIXES; i++) flights.set([(i * .61803398875) % 1, seed(i, 2), seed(i, 3), seed(i, 4)], i * 4);
  swarmGeometry.setAttribute('aFlight', new T.InstancedBufferAttribute(flights, 4));
  swarmGeometry.setAttribute('aHome', new T.InstancedBufferAttribute(homes, 3));
  swarmGeometry.setAttribute('aPerch', new T.InstancedBufferAttribute(perches, 3));
  const swarmMaterial = own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: wingVertex, fragmentShader: wingFragment,
    defines: { SWARM: 1 }, side: T.DoubleSide, forceSinglePass: true, transparent: true, depthWrite: false }));
  const swarm = own(ctx, new T.InstancedMesh(swarmGeometry, swarmMaterial, PHOENIXES));
  swarm.name = 'phoenix-swarm'; swarm.frustumCulled = false; swarm.renderOrder = 2; world.add(swarm);

  const flameGeometry = swarmGeometry;
  flameGeometry.setAttribute('aFlight', swarmGeometry.getAttribute('aFlight'));
  flameGeometry.setAttribute('aHome', swarmGeometry.getAttribute('aHome'));
  const flameMaterial = own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: wingVertex, fragmentShader: flameFragment,
    defines: { SWARM: 1, FLAMES: 1 }, side: T.DoubleSide, forceSinglePass: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
  const flames = own(ctx, new T.InstancedMesh(flameGeometry, flameMaterial, PHOENIXES));
  flames.name = 'phoenix-flames'; flames.frustumCulled = false; flames.renderOrder = 3; world.add(flames);

  const emberGeometry = own(ctx, new T.InstancedBufferGeometry());
  const emberPositions = [], emberUvs = [], emberFans = [], emberSides = [], emberParts = [], emberPhases = [];
  for (let i = 0; i < 12; i++) {
    const side = i % 2 ? 1 : -1, tail = i >= 6;
    emberPositions.push(side * (tail ? .6 : 2.1), tail ? -3.4 : 1.4, .1);
    emberUvs.push(.5 + side * .12, tail ? .8 : .4); emberFans.push(.3, .8);
    emberSides.push(side); emberParts.push(tail ? 1 : 0); emberPhases.push(i / 12);
  }
  emberGeometry.setAttribute('position', new T.Float32BufferAttribute(emberPositions, 3));
  emberGeometry.setAttribute('uv', new T.Float32BufferAttribute(emberUvs, 2));
  emberGeometry.setAttribute('aFan', new T.Float32BufferAttribute(emberFans, 2));
  emberGeometry.setAttribute('aSide', new T.Float32BufferAttribute(emberSides, 1));
  emberGeometry.setAttribute('aPart', new T.Float32BufferAttribute(emberParts, 1));
  emberGeometry.setAttribute('aEmber', new T.Float32BufferAttribute(emberPhases, 1));
  emberGeometry.setAttribute('aFlight', swarmGeometry.getAttribute('aFlight'));
  emberGeometry.setAttribute('aHome', swarmGeometry.getAttribute('aHome'));
  emberGeometry.setAttribute('aPerch', swarmGeometry.getAttribute('aPerch'));
  const emberMaterial = own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: wingVertex, fragmentShader: emberFragment,
    defines: { SWARM: 1, EMBERS: 1 }, transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
  const embers = new T.Points(emberGeometry, emberMaterial);
  embers.name = 'phoenix-embers'; embers.frustumCulled = false; embers.renderOrder = 4; world.add(embers);

  // Egg and ritual ---------------------------------------------------------
  const eggGeometry = buildEggGeometry(ctx);
  const eggMaterial = own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: eggVertex, fragmentShader: eggFragment,
    transparent: true, depthWrite: true }));
  const egg = new T.Mesh(eggGeometry, eggMaterial);
  egg.name = 'phoenix-egg'; egg.position.set(...NEST); egg.scale.setScalar(1); egg.frustumCulled = false; egg.renderOrder = 5; world.add(egg);
  const eggFire = new T.Mesh(eggGeometry, own(ctx, new T.ShaderMaterial({ uniforms,
    vertexShader: eggVertex, fragmentShader: eggFireFragment, transparent: true, depthWrite: false, depthTest: true, blending: T.AdditiveBlending })));
  eggFire.name = 'phoenix-egg-fire'; eggFire.scale.setScalar(1.035); eggFire.renderOrder = 6; eggFire.frustumCulled = false; egg.add(eggFire);
  const eggRingMaterial = own(ctx, new T.ShaderMaterial({ uniforms,
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: fireRingFragment, transparent: true, depthWrite: false, depthTest: true, blending: T.AdditiveBlending, side: T.DoubleSide }));
  const fireRingA = new T.Mesh(own(ctx, new T.TorusGeometry(2.28, .045, 8, 160)), eggRingMaterial);
  const fireRingB = new T.Mesh(own(ctx, new T.TorusGeometry(2.68, .03, 8, 160)), eggRingMaterial);
  for (const ring of [fireRingA, fireRingB]) { ring.name = 'phoenix-egg-ring'; ring.position.set(NEST[0], NEST[1] - 2.85, NEST[2]); ring.frustumCulled = false; ring.renderOrder = 4; ring.visible = false; world.add(ring); }
  const vortexMaterial = own(ctx, new T.ShaderMaterial({ uniforms,
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: vortexFragment, transparent: true, depthWrite: false, depthTest: true, blending: T.AdditiveBlending, side: T.DoubleSide }));
  const vortexA = new T.Mesh(own(ctx, new T.CylinderGeometry(2.95, 2.3, 5.9, 96, 1, true)), vortexMaterial);
  const vortexB = new T.Mesh(own(ctx, new T.CylinderGeometry(2.12, 1.72, 6.6, 96, 1, true)), vortexMaterial);
  for (const [mesh, dir] of [[vortexA, 1], [vortexB, -1]]) {
    mesh.name = 'phoenix-fire-vortex'; mesh.userData.dir = dir;
    mesh.position.set(NEST[0], NEST[1] - .3, NEST[2] - 1.0); mesh.frustumCulled = false; mesh.renderOrder = 4; mesh.visible = false; world.add(mesh);
  }

  const eclipse = new T.Mesh(own(ctx, new T.PlaneGeometry(9.4, 9.4)), own(ctx, new T.ShaderMaterial({ uniforms,
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: eclipseFragment, transparent: true, depthWrite: false, depthTest: false })));
  eclipse.name = 'phoenix-ring'; eclipse.position.set(NEST[0], 2.15, NEST[2] - 1.9); eclipse.renderOrder = -5; eclipse.frustumCulled = false; world.add(eclipse);

  const runeGroup = new T.Group(); runeGroup.position.set(NEST[0], 1.55, NEST[2] - 2.3); world.add(runeGroup);
  const runePlane = new T.Mesh(own(ctx, new T.PlaneGeometry(14, 14)), own(ctx, new T.ShaderMaterial({ uniforms,
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: runesFragment, transparent: true, depthWrite: false, depthTest: false, blending: T.AdditiveBlending })));
  runePlane.name = 'phoenix-runes'; runePlane.renderOrder = -4; runePlane.frustumCulled = false; runeGroup.add(runePlane);

  const ritual = new T.Mesh(own(ctx, new T.PlaneGeometry(9, 9)), own(ctx, new T.ShaderMaterial({ uniforms,
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: ritualFragment, transparent: true, depthWrite: false, depthTest: false, blending: T.AdditiveBlending })));
  ritual.name = 'phoenix-ritual'; ritual.position.set(...NEST); ritual.renderOrder = 6; ritual.frustumCulled = false; world.add(ritual);

  const core = createGlow(ctx, world, { color: 0xffd9a0, opacity: 0, size: 2.2, depthTest: true }); core.mesh.position.set(NEST[0], NEST[1] + .3, NEST[2] - 1.7);
  const aura = createGlow(ctx, world, { color: 0xc23a1d, opacity: 0, size: 8, depthTest: true }); aura.mesh.position.copy(core.mesh.position);
  const flare = createGlow(ctx, world, { color: 0xffb36b, opacity: 0, size: 1, depthTest: true }); flare.mesh.position.copy(core.mesh.position); flare.mesh.scale.set(2.4, .001, 1);
  const cursor = createGlow(ctx, world, { color: 0xffb06a, opacity: 0, size: .8 });
  const cursorRingGroup = new T.Group(); world.add(cursorRingGroup);
  const cursorRingMaterial = own(ctx, new T.MeshBasicMaterial({ color: 0xffa050, transparent: true, opacity: 0, depthWrite: false, depthTest: false, blending: T.AdditiveBlending, side: T.DoubleSide }));
  const cursorRing = new T.Mesh(own(ctx, new T.RingGeometry(.86, .95, 64)), cursorRingMaterial);
  cursorRing.renderOrder = 9; cursorRingGroup.add(cursorRing);
  const shock = createShockPool(ctx, world, { count: 5, duration: 1.05, opacity: .95 }); own(ctx, shock.mesh);

  // Shell shards -----------------------------------------------------------
  const shardGeometry = own(ctx, new T.TetrahedronGeometry(.13, 0));
  const shardDirs = new Float32Array(SHARDS * 3), shardSeeds = new Float32Array(SHARDS);
  for (let i = 0; i < SHARDS; i++) {
    const a = seed(i, 21) * TAU, y = seed(i, 22) * 2 - 1, r = Math.sqrt(1 - y * y);
    shardDirs.set([Math.cos(a) * r, y * .6 + .2, Math.sin(a) * r], i * 3);
    shardSeeds[i] = seed(i, 23);
  }
  shardGeometry.setAttribute('aDir', new T.InstancedBufferAttribute(shardDirs, 3));
  shardGeometry.setAttribute('aShard', new T.InstancedBufferAttribute(shardSeeds, 1));
  const shardMaterial = own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: shardVertex, fragmentShader: shardFragment,
    transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
  const shards = own(ctx, new T.InstancedMesh(shardGeometry, shardMaterial, SHARDS));
  shards.name = 'phoenix-shards'; shards.frustumCulled = false; shards.renderOrder = 6; shards.visible = false; world.add(shards);
  const shardDummy = new T.Object3D(); for (let i = 0; i < SHARDS; i++) { shardDummy.updateMatrix(); shards.setMatrixAt(i, shardDummy.matrix); }
  shards.instanceMatrix.needsUpdate = true;

  const dustGeometry = (count, trails_) => {
    const position = [], data = [], ends = [];
    for (let i = 0; i < count; i++) for (let end = 0; end < (trails_ ? 2 : 1); end++) {
      position.push((seed(i, 8) - .5) * 34, (seed(i, 9) - .5) * 21, -seed(i, 10) * 28);
      data.push(seed(i, 11), seed(i, 12), seed(i, 13), seed(i, 14)); ends.push(end);
    }
    const geometry = own(ctx, new T.BufferGeometry());
    geometry.setAttribute('position', new T.Float32BufferAttribute(position, 3));
    geometry.setAttribute('aDust', new T.Float32BufferAttribute(data, 4));
    geometry.setAttribute('aTrail', new T.Float32BufferAttribute(ends, 1));
    return geometry;
  };
  const dustMaterial = trails_ => own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: dustVertex, fragmentShader: dustFragment,
    defines: trails_ ? { TRAILS: 1 } : {}, transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
  const dust = new T.Points(dustGeometry(DUST), dustMaterial(false)); dust.frustumCulled = false; dust.renderOrder = 1; world.add(dust);
  const trails = new T.LineSegments(dustGeometry(TRAILS), dustMaterial(true)); trails.frustumCulled = false; trails.renderOrder = 1; world.add(trails);

  const veil = new T.Mesh(own(ctx, new T.PlaneGeometry(26, 26)), own(ctx, new T.ShaderMaterial({ uniforms,
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}', fragmentShader: veilFragment,
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide })));
  veil.position.set(0, .9, -4.2); veil.renderOrder = -6; veil.frustumCulled = false; world.add(veil);
  const atmosphere = new T.Mesh(own(ctx, new T.PlaneGeometry(2, 2)), own(ctx, new T.ShaderMaterial({ uniforms,
    vertexShader: phoenixAtmosphereVertex, fragmentShader: phoenixAtmosphereFragment, depthTest: false, depthWrite: false })));
  atmosphere.name = 'phoenix-deep-space'; atmosphere.renderOrder = -20; atmosphere.frustumCulled = false; world.add(atmosphere);
  const stars = createStarfield(ctx, world, { count: 1800, near: 30, far: 72, palette: [0xd9e9ff, 0x8bb7ec, 0xffdab0], opacity: .65, size: [.55, 1.5] });
  const starTravel = createPhoenixStarTravel(ctx, world, uniforms);
  const sanctum = createPhoenixSanctum(ctx, world, uniforms);

  const spawnQuat = new T.Quaternion(), parentQuat = new T.Quaternion(), cameraQuat = new T.Quaternion();
  const strikePoint = new T.Vector3(), shockPoint = new T.Vector3();
  let params = { ...ctx.params }, profile = ctx.quality, elapsed = 0, boost = 0, burstAge = 20, surgeAge = 20, lastSerial = null, performanceChanged = false;
  let { flight, swarm: swarmW, gather, egg: eggW, flash } = phoenixTimeline(0, params.performance);
  let stirPhase = 0, pointerLock = null, burstCount = 0, pendingShock = null;
  let strikes = 0, strikeAge = 10, hatchAge = 10, shardAge = 10, shardPower = 1, autoHatch = false, cycleT = 0;
  let hatchStarted = false, charge = 0;
  let timelineTime = 0, manualRitual = false, manualIdle = 0, holdFull = 0, formed = false, hatchShock = false;

  function density() {
    const fraction = qualityDensity(profile) * (params.density ?? 1);
    swarm.count = Math.max(1, Math.min(PHOENIXES, Math.round(PHOENIXES * (.333 + qualityDensity(profile) * .667) * (params.density ?? 1))));
    flames.count = swarm.count; emberGeometry.instanceCount = swarm.count;
    shards.count = Math.max(24, Math.floor(SHARDS * Math.max(.55, fraction)));
    dust.geometry.setDrawRange(0, Math.floor(DUST * fraction));
    trails.geometry.setDrawRange(0, Math.floor(TRAILS * fraction) * 2);
    uniforms.uFine.value = profile?.mode === 'low' ? 0 : 1; stars.setDensity(fraction * .55);
    starTravel.setDensity(fraction * .65);
    sanctum.setDensity(fraction);
  }

  function startRitual() {
    if (manualRitual || hatchStarted) return;
    manualRitual = true; manualIdle = 0; holdFull = 0; strikes = 0; charge = 0; uniforms.uCharge.value = 0;
    timelineTime = Math.floor(timelineTime / 36) * 36 + 6; hatchAge = 10; shardAge = 10; strikeAge = 10;
    flash = Math.max(flash, .4); burstAge = 0;
    pendingShock = new T.Vector3(0, 1.4, .5);
    burstCount++;
  }

  function beginHatch(power = 1.8) {
    if (hatchStarted) return;
    strikes = 3; hatchAge = 0; hatchStarted = true; shardAge = 0; shardPower = power; surgeAge = 0;
    flash = 1; autoHatch = true; manualRitual = false; manualIdle = 0; holdFull = 0; hatchShock = true;
    timelineTime = Math.floor(timelineTime / 36) * 36 + 31.2;
    pendingShock = new T.Vector3(NEST[0], NEST[1] + .2, NEST[2] - .7);
  }

  function strike(power = 1) {
    if (hatchStarted) return;
    const impact = power > 1 ? 2 : 1;
    strikes = Math.min(3, strikes + impact); strikeAge = 0; shardAge = 0; shardPower = Math.max(1, power);
    const point = uniforms.uPointer.value;
    shockPoint.copy(point);
    strikePoint.set(point.x - NEST[0], point.y - NEST[1], 1.0);
    uniforms.uStrike.value.copy(strikePoint);
    uniforms.uStrikeAge.value = 0;
    pendingShock = new T.Vector3(NEST[0], NEST[1] + .2, NEST[2] + .9);
    burstCount++;
    flash = Math.max(flash, .26 + .14 * impact);
    manualIdle = 0; holdFull = 0;
    if (strikes >= 3) beginHatch(power > 1 ? 2 : 1.6);
  }

  function appearance() {
    const time = elapsed, amount = uniforms.uPointerAmount.value;
    uniforms.uTime.value = elapsed; uniforms.uFlight.value = flight; uniforms.uSwarm.value = swarmW;
    uniforms.uGather.value = gather; uniforms.uEgg.value = eggW; uniforms.uFlash.value = flash;
    const ritualAmount = Math.max(gather, eggW);
    uniforms.uFire.value = smooth(.05, .4, Math.max(swarmW, gather * .82));
    uniforms.uRing.value = Math.min(1, Math.max(gather * .25, eggW * .3) + flash * .7 + charge * .25);
    uniforms.uRunes.value = .23 * Math.min(1, Math.max(gather * .7, eggW * .55, flash * .85) + charge * .25);
    uniforms.uRitual.value = Math.min(1, ritualAmount * .12 + charge * .75 + flash * .2);
    const emerging = hatchStarted || (params.performance === 'auto' && cycleT > 31.2);
    uniforms.uScatter.value = emerging ? 0 : Math.max(1 - flight, gather);
    uniforms.uDissolve.value = emerging ? 0 : 1 - flight;
    uniforms.uHero.value = emerging ? smooth(0, .32, hatchAge) : (flight > .002 ? 1 : 0);
    uniforms.uGhost.value = hatchAge < 1.9 ? (1 - hatchAge / 1.9) * smooth(0, .12, hatchAge) : 0;
    uniforms.uHatch.value = uniforms.uGhost.value;
    uniforms.uStrikeAge.value = Math.min(10, strikeAge);
    uniforms.uShardAge.value = Math.min(10, shardAge); uniforms.uShardPower.value = shardPower;
    uniforms.uSpeed.value = .07 * flight + flash * .04;
    // A deliberate downstroke and softer recovery, roughly one beat per 2.4s.
    const beat = time * 2.65 - .22 * Math.sin(time * 2.65);
    uniforms.uFlap.value = .13 + Math.sin(beat) * .34 + uniforms.uBass.value * uniforms.uResponse.value * .025;
    uniforms.uSweep.value = Math.sin(beat - .55) * .29;
    uniforms.uWingLift.value = emerging ? .4 * (1 - smooth(0, 2.7, hatchAge)) : .02;
    uniforms.uSize.value = params.pointSize ?? 1; uniforms.uResponse.value = params.reactivity ?? .7;
    uniforms.uStir.value = stirPhase;
    uniforms.uStrikes.value = strikes;
    uniforms.uCrack.value = Math.min(1, .1 + strikes / 3 * .9 + charge * .35 + (params.performance === 'auto' && !manualRitual ? smooth(26.5, 31.3, cycleT) * .55 : 0));

    const heroVisible = uniforms.uHero.value > .01;
    hero.visible = heroVisible;
    const unfurl = emerging ? smooth(0, 3.0, hatchAge) : 1;
    // The approved phoenix stays centered and upright throughout the release.
    // Camera dragging still reveals the artwork's relief, but the bird does not bank.
    hero.position.set(-.18, .55 + Math.sin(time * .7) * .09, .3);
    hero.position.sub(nestPosition).multiplyScalar(unfurl).add(nestPosition);
    hero.rotation.set(0, .14, 0);
    hero.scale.setScalar(.12 + unfurl * .9);
    hero.updateMatrix(); uniforms.uHeroMatrix.value.copy(hero.matrix);
    const flockVisible = (swarmW > .015 || gather > .06) && eggW < .995 && !emerging;
    swarm.visible = flockVisible;
    flames.visible = embers.visible = uniforms.uFire.value > .001 && flockVisible;
    trails.visible = gather > .08 && eggW < .3;
    egg.visible = eggW > .012;
    const kick = strikeAge < .9 ? Math.exp(-strikeAge * 8) * .055 * shardPower : 0;
    const hatchScale = 1.16 + kick + uniforms.uHatch.value * .16;
    egg.scale.setScalar(hatchScale);
    egg.rotation.y = Math.sin(time * .24) * .07 + uniforms.uPointer.value.x * .012;
    egg.rotation.x = Math.sin(time * .19) * .025 - uniforms.uPointer.value.y * .008;
    eggFire.visible = eggW > .03;
    const fireRingsOn = eggW > .03;
    fireRingA.visible = fireRingB.visible = fireRingsOn;
    if (fireRingsOn) {
      const spread = 1 + uniforms.uHatch.value * 1.6;
      fireRingA.scale.setScalar(spread);
      fireRingB.scale.setScalar(spread);
      fireRingA.rotation.set(1.43 + Math.sin(time * .37) * .035, 0, time * .3 + charge * 1.5);
      fireRingB.rotation.set(1.46 + Math.sin(time * .29) * .035, 0, -time * .22 - charge * 1.1);
    }
    const vortexOn = eggW > .05;
    vortexA.visible = vortexB.visible = vortexOn;
    if (vortexOn) {
      const grow = 1 + uniforms.uHatch.value * .5;
      vortexA.scale.set(grow, 1 + uniforms.uHatch.value * .35, grow);
      vortexB.scale.set(grow, 1 + uniforms.uHatch.value * .2, grow);
      vortexA.rotation.y = time * .34 + charge * 1.15;
      vortexB.rotation.y = -time * .23 - charge * .8;
    }
    eclipse.visible = uniforms.uRing.value > .003;
    runeGroup.visible = runePlane.visible = uniforms.uRunes.value > .003;
    ritual.visible = uniforms.uRitual.value > .003;
    const runeScale = 1 - charge * .1;
    runeGroup.scale.setScalar(runeScale);
    runePlane.rotation.z = time * .012 + stirPhase * .06;
    ritual.scale.setScalar(1.12 - charge * .28 + eggW * .02);
    core.set(undefined, eggW * (.52 + uniforms.uBass.value * uniforms.uResponse.value * .1) + flash * .26 + charge * .22 + uniforms.uGhost.value * .1, 2.2 + eggW * .5 + flash * .8 + charge * .4);
    aura.set(undefined, eggW * .34 + flash * .22 + charge * .2 + uniforms.uGhost.value * .16, 8 + flash * 1.2 + charge * .9);
    flare.set(undefined, flash * .2);
    flare.mesh.scale.set(5.4 + flash * 2.2, .001 + 2.2 * flash, 1);
    const quake = Math.min(.11, charge * .012 + (strikeAge < 1.2 ? Math.exp(-strikeAge * 6) * .045 * shardPower : 0) + uniforms.uGhost.value * .02);
    world.position.set(Math.sin(time * 73) * quake, Math.cos(time * 61) * quake, 0);
    world.rotation.z = Math.sin(time * 59) * quake * .5;
    eclipse.position.y = 2.15 + uniforms.uHero.value * .85;
    faceCamera(core.mesh, ctx.camera); faceCamera(aura.mesh, ctx.camera); faceCamera(flare.mesh, ctx.camera);
    faceCamera(eclipse, ctx.camera); faceCamera(runeGroup, ctx.camera); faceCamera(ritual, ctx.camera);
    shards.visible = shardAge < 1.35;
    shards.count = Math.max(24, Math.floor(SHARDS * Math.max(.55, qualityDensity(profile) * (params.density ?? 1))));

    cursor.set(undefined, amount * (.14 + charge * .16), .7 + charge * .5);
    cursor.mesh.position.copy(uniforms.uPointer.value); faceCamera(cursor.mesh, ctx.camera);
    const inRitual = swarmW > .06 || gather > .06 || eggW > .05;
    cursorRingGroup.visible = amount > .01 && (inRitual || flight > .2);
    if (cursorRingGroup.visible) {
      cursorRingGroup.position.copy(uniforms.uPointer.value);
      faceCamera(cursorRingGroup, ctx.camera);
      cursorRing.rotation.z = time * 1.15 + stirPhase * .5;
      cursorRing.scale.setScalar(.48 + charge * .5 + gather * .18);
      cursorRingMaterial.opacity = amount * (.32 + charge * .5) * (.65 + gather * .35 + flight * .25);
    }
    stars.uniforms.uTime.value = time;
  }
  density(); appearance();

  return basicInstance(group, params, profile, {
    update(frame, p) {
      const click = frame.pointer?.click;
      const dt = frame.reduced || frame.playing === false ? 0 : Math.max(0, Math.min(.1, Number(frame.dt) || 0));
      if (performanceChanged) {
        manualRitual = false; manualIdle = 0; holdFull = 0; timelineTime = 0; strikes = 0; charge = 0;
        uniforms.uCharge.value = 0; hatchStarted = false; hatchAge = 10; shardAge = 10; formed = false; autoHatch = false;
      }
      if (performanceChanged && dt === 0) {
        ({ flight, swarm: swarmW, gather, egg: eggW, flash } = phoenixTimeline(0, p.performance));
        boost = 0; burstAge = 20; surgeAge = 20; uniforms.uBurst.value = 0; strikes = 0; hatchAge = 10; charge = 0; uniforms.uCharge.value = 0;
      }
      performanceChanged = false;
      if (frame.reduced) {
        lastSerial = click?.serial ?? lastSerial; charge = 0; uniforms.uCharge.value = 0;
        // Keep the current hatch pose when freezing midway through rebirth.
        shock.update(0, true); appearance(); return;
      }
      pointer.update(frame, p.pointerStrength ?? 1);
      const source = frame.pointer, inRitual = swarmW > .1 || gather > .1 || eggW > .05;
      if (inRitual && source?.active && (source.down || source.dragging) && Number.isFinite(source.x) && Number.isFinite(source.y)) {
        if (pointerLock && Math.abs(source.x - pointerLock.x) + Math.abs(source.y - pointerLock.y) > .001) {
          const dx = source.x - pointerLock.x, dy = source.y - pointerLock.y;
          stirPhase = Math.max(-3, Math.min(3, stirPhase + (pointerLock.x * dy - pointerLock.y * dx) * 2.4));
        }
        pointerLock = { x: source.x, y: source.y };
      } else {
        pointerLock = null;
        if (!inRitual) stirPhase = 0;
      }
      if (lastSerial === null) lastSerial = click?.serial ?? 0;
      else if (click && click.serial !== lastSerial) {
        lastSerial = click.serial; burstAge = 0;
        if (inRitual) {
          // A ritual click strikes the egg once it is present; earlier in the
          // gathering it feeds the vortex and hurries the shell into shape.
          if (eggW > .12) strike(charge > .8 ? 1.6 : 1);
          else {
            burstCount++; pendingShock = uniforms.uPointer.value.clone();
            if (manualRitual) { timelineTime += 1.1; flash = Math.max(flash, .3); }
          }
        } else if (flight > .15 || swarmW > .1) {
          startRitual();
        }
      }
      shock.update(dt, false);
      if (pendingShock) {
        group.updateMatrixWorld(true);
        world.getWorldQuaternion(parentQuat).invert();
        ctx.camera.getWorldQuaternion(cameraQuat);
        shock.spawn(pendingShock, spawnQuat.copy(parentQuat).multiply(cameraQuat), 2.2 + gather * 1.8 + charge * .8 + (shardAge < .2 ? shardPower * .8 : 0), 0xffab5e);
        pendingShock = null;
      }
      if (hatchShock) {
        group.updateMatrixWorld(true);
        world.getWorldQuaternion(parentQuat).invert();
        ctx.camera.getWorldQuaternion(cameraQuat);
        shock.spawn(new T.Vector3(NEST[0], NEST[1] + .2, NEST[2] - .7), spawnQuat.copy(parentQuat).multiply(cameraQuat), 8.4, 0xffd494);
        hatchShock = false;
      }
      burstAge += dt; surgeAge += dt; strikeAge += dt; hatchAge += dt; shardAge += dt;
      if (hatchStarted && hatchAge > 3.3) { strikes = 0; hatchStarted = false; }
      boost += ((burstAge < 2.2 ? 1 : 0) - boost) * approach(dt, burstAge < 2.2 ? .48 : 1.2);
      const rate = dt * (p.speed ?? .6) / .6;
      elapsed += rate;
      if (manualRitual && !hatchStarted && cycleT > 26.2) manualIdle += dt;
      else timelineTime += rate;
      cycleT = ((timelineTime % 36) + 36) % 36;
      // A manual rite always plays the full auto choreography, whichever
      // preset it was started from; afterwards the chosen preset resumes.
      const target = phoenixTimeline(timelineTime, manualRitual || hatchStarted ? 'auto' : (p.performance || 'auto'));
      flight += (target.flight - flight) * approach(dt, .6);
      swarmW += (target.swarm - swarmW) * approach(dt, .55);
      gather += (target.gather - gather) * approach(dt, .7);
      eggW += (target.egg - eggW) * approach(dt, .65);
      if (!formed && eggW > .9) {
        formed = true; flash = Math.max(flash, .42);
        pendingShock = new T.Vector3(NEST[0], NEST[1] + .2, NEST[2]);
        burstCount++;
      } else if (eggW < .32) formed = false;
      if (manualRitual && !hatchStarted && source?.down) manualIdle = 0;
      if (manualRitual && !hatchStarted && eggW > .5 && manualIdle > 12) beginHatch(1.4);
      const surge = surgeAge < 3.4 ? Math.exp(-surgeAge * .9) : 0;
      flash += (Math.max(target.flash, surge) - flash) * approach(dt, .22);
      uniforms.uBass.value = frame.bands?.bass ?? 0; uniforms.uMid.value = frame.bands?.mid ?? 0; uniforms.uTreble.value = frame.bands?.treble ?? 0;
      uniforms.uPixel.value = ctx.renderer?.getPixelRatio() || 1;
      uniforms.uBurst.value = Math.exp(-burstAge * 1.8) * smooth(0, .2, burstAge);
      const holding = !!(source?.down && !source.dragging && inRitual);
      charge += ((holding ? 1 : 0) - charge) * approach(dt, .5);
      uniforms.uCharge.value = charge;
      if (holding && eggW > .35 && charge > .96 && !hatchStarted) {
        holdFull += dt;
        if (holdFull > 1.15) beginHatch(1.8);
      } else holdFull = 0;
      if (p.performance === 'auto' && cycleT > 31.2 && !autoHatch && gather > .1) beginHatch(1.6);
      if (cycleT < 5) autoHatch = false;
      appearance();
      uniforms.uTravel.value += rate * (1.2 + uniforms.uSpeed.value * 68);

    },
    resize(w, h) { uniforms.uHeight.value = h; uniforms.uAspect.value = w / Math.max(1, h); stars.uniforms.uHeight.value = h; },
    params(next) { performanceChanged ||= params.performance !== next.performance; params = next; density(); },
    quality(next) { profile = next; density(); },
    stats: () => {
      const phase = hatchStarted || (params.performance === 'auto' && cycleT > 31.2) ? 'rebirth' : manualRitual ? (eggW > .55 ? 'egg' : 'gather') : eggW > .55 ? 'egg' : gather > .12 ? 'gather' : flight > .5 ? 'flight' : 'swarm';
      return { phoenixes: swarm.count, dust: dust.geometry.drawRange.count, flight, swarm: swarmW, gather, egg: eggW, flash,
        interactionBoost: boost, stir: stirPhase, charge, bursts: burstCount, strikes, crack: uniforms.uCrack.value, hatch: uniforms.uHatch.value,
        shards: shards.visible ? shards.count : 0, travel: uniforms.uTravel.value, speed: uniforms.uSpeed.value,
        elapsed, phase, manual: manualRitual, timeline: timelineTime, hold: holdFull };
    }
  });
}

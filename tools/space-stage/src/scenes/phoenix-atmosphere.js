// SPDX-License-Identifier: MIT
// Deep space and perspective star travel share the performance's frozen clock.
import { own, seed } from './factories.js';

export const phoenixAtmosphereVertex = `
varying vec2 vUv;
void main(){vUv=uv;gl_Position=vec4(position.xy,1.0,1.0);}
`;

export const phoenixAtmosphereFragment = `
uniform float uTime,uAspect,uFlash,uHatch,uFine;
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
 float r=length(p),t=uTime*.025;
 vec2 space=p+vec2(sin(t*.27)*.2,-t*.36);
 float warp=fbm(space*.23+vec2(t*.18,0.0));
 float cloud=fbm(space*.56+warp*2.4);
 float fine=fbm(space*1.5+vec2(4.7,1.3));
 float lower=exp(-pow((p.y+5.2+(warp-.5)*3.5)/3.2,2.0));
 float chamber=exp(-dot(p*vec2(.1,.14),p*vec2(.1,.14)));
 float shaft=exp(-pow((p.x+p.y*.38+3.0)/2.3,2.0))*smoothstep(-5.0,7.0,p.y);
 vec3 color=vec3(.0015,.0023,.0035);
 color+=vec3(.009,.014,.018)*shaft*(.3+cloud*.7);
 color+=vec3(.018,.014,.011)*chamber*cloud;
 color+=vec3(.065,.022,.006)*lower*cloud*(.35+fine)*(.7+uFlash*.8);
 color+=vec3(.009,.012,.014)*pow(cloud,3.0)*(1.0-chamber*.6);
 float wave=exp(-pow((r-(2.0+(1.0-uHatch)*11.0))/.3,2.0))*uHatch;
 color+=vec3(.2,.075,.02)*wave;
 color+=vec3(.055,.025,.008)*uFlash*chamber;
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
 vec3 silver=mix(vec3(.25,.33,.36),vec3(.8,.85,.88),aStar.w);
 vColor=mix(silver,vec3(1.0,.7,.32),step(.9,aStar.w));
 vAlpha=nearFade*farFade*(.12+aStar.w*.42);
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

const sanctumNoise = `
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
 return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.0),f.x),f.y);}
float smoke(vec2 p){return noise(p)*.57+noise(p*2.03+7.1)*.28+noise(p*4.1+13.7)*.15;}
`;

const ashFragment = `
uniform float uTime,uFlash,uGather; varying vec2 vUv;
${sanctumNoise}
void main(){
 vec2 p=(vUv-.5)*56.0;
 float r=length(p),a=atan(p.y,p.x),t=uTime*.07;
 float n=smoke(p*.33+vec2(t,-t*.4));
 float drift=smoke(p*.72+n*2.2-vec2(t*.4,t*.3));
 float pool=exp(-r*r*.018), rim=exp(-pow((r-5.8-n*2.2)/1.4,2.0));
 float channels=pow(.5+.5*sin(a*3.0+r*.9-t+n*3.0),6.0);
 vec3 color=mix(vec3(.022,.027,.029),vec3(.13,.062,.022),pool);
 color+=vec3(.2,.075,.012)*rim*channels*(.35+uGather*.2+uFlash*.55);
 float alpha=(.12+n*.33+drift*.24)*(1.0-smoothstep(14.0,25.0,r));
 color*=.65+drift*.75+uFlash*.25;
 gl_FragColor=vec4(color,alpha);
 #include <colorspace_fragment>
}`;

const cinderVertex = `
uniform float uTime; varying vec2 vUv; varying float vFade;
void main(){
 float progress=position.x, lane=position.z, edge=position.y;
 float angle=progress*8.8+lane*2.0943951+uTime*.095;
 float radius=3.5+progress*7.2;
 float width=(.12+sin(progress*3.14159265)*.45)*edge;
 vec3 p=vec3(cos(angle)*(radius+width),-5.0+progress*1.55+sin(angle)*.3,sin(angle)*(radius+width)-1.4);
 p.y+=sin(angle*2.0-uTime*.28+lane)*.13+width*.45;
 vUv=vec2(progress,edge*.5+.5);
 vFade=smoothstep(0.0,.12,progress)*(1.0-smoothstep(.72,1.0,progress));
 gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
}`;

const cinderFragment = `
uniform float uTime,uFlash,uGather; varying vec2 vUv; varying float vFade;
${sanctumNoise}
void main(){
 float n=smoke(vec2(vUv.x*31.0-uTime*.2,vUv.y*3.0));
 float thread=exp(-pow((vUv.y-.5+(n-.5)*.28)*12.0,2.0));
 float vapor=exp(-pow((vUv.y-.5)*3.8,2.0))*n*.18;
 float breaks=smoothstep(.28,.68,n);
 float alpha=(thread*.5+vapor)*breaks*vFade*(.45+uGather*.3+uFlash*.6);
 vec3 color=mix(vec3(.48,.14,.028),vec3(1.1,.58,.17),thread*n);
 gl_FragColor=vec4(color,alpha);
 #include <colorspace_fragment>
}`;

const nearEmberVertex = `
attribute vec4 aEmber;
uniform float uTime,uHeight,uPixel,uFlash; varying float vAlpha,vSeed;
void main(){
 float life=fract(aEmber.x+uTime*(.045+aEmber.w*.045));
 float angle=aEmber.y*6.2831853+life*.8;
 float radius=4.8+aEmber.z*7.0;
 vec3 p=vec3(cos(angle)*radius,-5.6+life*12.0,sin(angle)*radius*.75);
 p.x+=sin(life*7.0+aEmber.w*20.0)*.4;
 vec4 mv=modelViewMatrix*vec4(p,1.0);
 gl_Position=projectionMatrix*mv;
 float nearFade=smoothstep(2.0,6.0,-mv.z);
 gl_PointSize=clamp(uPixel*uHeight*(.035+aEmber.w*.09)/max(2.0,-mv.z),1.0,9.0);
 vAlpha=sin(life*3.14159265)*(.16+aEmber.w*.48)*nearFade*(1.0+uFlash*.5);
 vSeed=aEmber.w;
}`;

const nearEmberFragment = `
varying float vAlpha,vSeed;
void main(){
 vec2 p=gl_PointCoord-.5;
 float angle=vSeed*6.2831853;
 p=mat2(cos(angle),-sin(angle),sin(angle),cos(angle))*p;
 float d=length(p*vec2(1.0,1.8));
 if(d>.5)discard;
 gl_FragColor=vec4(mix(vec3(.68,.23,.055),vec3(1.2,.76,.32),vSeed),exp(-d*d*18.0)*vAlpha);
 #include <colorspace_fragment>
}`;

export function createPhoenixSanctum(ctx, parent, uniforms) {
  const T = ctx.THREE;
  const ash = new T.Mesh(own(ctx, new T.PlaneGeometry(56, 56)), own(ctx, new T.ShaderMaterial({ uniforms,
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: ashFragment, transparent: true, depthWrite: false, side: T.DoubleSide })));
  ash.name = 'phoenix-ash-bed'; ash.rotation.x = -Math.PI / 2; ash.position.set(0, -5.65, -1.4);
  ash.renderOrder = -3; ash.frustumCulled = false; parent.add(ash);
  const positions = [], indices = [], segments = 160;
  for (let lane = 0; lane < 3; lane++) {
    const start = positions.length / 3;
    for (let i = 0; i <= segments; i++) positions.push(i / segments, -1, lane, i / segments, 1, lane);
    for (let i = 0; i < segments; i++) {
      const at = start + i * 2;
      indices.push(at, at + 1, at + 2, at + 1, at + 3, at + 2);
    }
  }
  const geometry = own(ctx, new T.BufferGeometry());
  geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices);
  const flow = new T.Mesh(geometry, own(ctx, new T.ShaderMaterial({ uniforms, vertexShader: cinderVertex, fragmentShader: cinderFragment,
    transparent: true, depthWrite: false, side: T.DoubleSide, forceSinglePass: true, blending: T.AdditiveBlending })));
  // Shader-positioned effects must follow the depth-writing hero and egg.
  flow.name = 'phoenix-cinder-flow'; flow.renderOrder = 7; flow.frustumCulled = false; parent.add(flow);
  const count = 480, embers = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) embers.set([seed(i, 71), seed(i, 72), seed(i, 73), seed(i, 74)], i * 4);
  const emberGeometry = own(ctx, new T.BufferGeometry());
  emberGeometry.setAttribute('position', new T.Float32BufferAttribute(new Float32Array(count * 3), 3));
  emberGeometry.setAttribute('aEmber', new T.Float32BufferAttribute(embers, 4));
  const sparks = new T.Points(emberGeometry, own(ctx, new T.ShaderMaterial({ uniforms,
    vertexShader: nearEmberVertex, fragmentShader: nearEmberFragment, transparent: true, depthWrite: false, blending: T.AdditiveBlending })));
  sparks.name = 'phoenix-near-embers'; sparks.renderOrder = 7; sparks.frustumCulled = false; parent.add(sparks);
  return { setDensity(fraction) { sparks.geometry.setDrawRange(0, Math.floor(count * Math.min(1, fraction))); } };
}

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

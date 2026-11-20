// SPDX-License-Identifier: MIT
// Plans for the pinned Three geometry constructors. Numeric-array payloads are
// declared before construction; this is not a JS heap or driver-memory meter.
const faces = { TetrahedronGeometry: 4, OctahedronGeometry: 8,
  IcosahedronGeometry: 20, DodecahedronGeometry: 36 };
const number = (args, index, fallback) => args[index] === undefined ? fallback : args[index];
function segments(value, minimum = 1) {
  if (!Number.isFinite(value) || value < minimum || value > 4096) throw new Error('geometry-plan-unavailable');
  return Math.max(minimum, Math.floor(value));
}
export function geometrySourcePlan(kind, args = []) {
  let vertices, indices = 0, scratch = 0;
  if (kind === 'PlaneGeometry') {
    const x=segments(number(args,2,1)),y=segments(number(args,3,1));
    vertices=(x+1)*(y+1);indices=x*y*6;
  } else if (kind === 'BoxGeometry') {
    const x=segments(number(args,3,1)),y=segments(number(args,4,1)),z=segments(number(args,5,1));
    vertices=2*((x+1)*(y+1)+(x+1)*(z+1)+(y+1)*(z+1));indices=12*(x*y+x*z+y*z);
  } else if (kind === 'SphereGeometry') {
    const w=segments(number(args,1,32),3),h=segments(number(args,2,16),2),start=number(args,5,0),length=number(args,6,Math.PI);
    vertices=(w+1)*(h+1);indices=6*w*h-(start===0?3*w:0)-(Math.min(start+length,Math.PI)===Math.PI?3*w:0);
    scratch=(vertices+h+1)*8; // The original nested index grid.
  } else if (kind === 'CylinderGeometry' || kind === 'ConeGeometry') {
    const cone=kind==='ConeGeometry',r=segments(number(args,cone?2:3,32)),h=segments(number(args,cone?3:4,1));
    const top=cone?0:number(args,0,1),bottom=number(args,cone?0:1,1),open=number(args,cone?4:5,false);
    const caps=open?0:Number(top>0)+Number(bottom>0);
    vertices=(r+1)*(h+1)+caps*(2*r+1);
    indices=6*r*h-(top>0?0:3*r)-(bottom>0?0:3*r)+caps*3*r;
    scratch=((r+1)*(h+1)+h+1)*8;
  } else if (kind === 'TorusGeometry') {
    const r=segments(number(args,2,12)),t=segments(number(args,3,48));
    vertices=(r+1)*(t+1);indices=6*r*t;
  } else if (kind === 'RingGeometry') {
    const t=segments(number(args,2,32),3),p=segments(number(args,3,1));
    vertices=(t+1)*(p+1);indices=6*t*p;
  } else if (kind === 'CircleGeometry') {
    const n=segments(number(args,1,32),3);vertices=n+2;indices=3*n;
  } else if (Object.hasOwn(faces,kind)) {
    const detail=number(args,1,0);
    if (!Number.isSafeInteger(detail)||detail<0||detail>32) throw new Error('geometry-plan-unavailable');
    const cols=detail+1;vertices=faces[kind]*cols*cols*3;
    // Polyhedron retains a sliced position list while creating normals, plus
    // one face's Vector3 subdivision grid and fixed source vertices/indices.
    scratch=vertices*3*8+(cols+1)*(cols+2)/2*3*8+(faces[kind]*3+60)*8;
  } else throw new Error('geometry-plan-unavailable:'+kind);
  const bufferBytes=vertices*32+indices*(vertices>65535?4:2);
  const cpuPeakBytes=bufferBytes+(vertices*8+indices)*8+scratch;
  if (![vertices,indices,bufferBytes,cpuPeakBytes].every(value=>Number.isSafeInteger(value)&&value>=0)
      ||vertices>4000000) throw new Error('geometry-plan-unavailable');
  return {vertices,indices,bufferBytes,cpuPeakBytes};
}
export function geometryBackingBytes(geometry) {
  const arrays=new Set();
  for(const attribute of [...Object.values(geometry.attributes),geometry.index].filter(Boolean))
    arrays.add((attribute.isInterleavedBufferAttribute?attribute.data:attribute).array.buffer);
  return [...arrays].reduce((bytes,array)=>bytes+array.byteLength,0);
}
export function constructedGeometry(THREE,scope,kind,args=[]) {
  const planned=geometrySourcePlan(kind,args);
  const admission=scope.bufferPlan(planned.cpuPeakBytes,planned.bufferBytes,'Three '+kind+' original numeric arrays');
  const geometry=scope.track(new THREE[kind](...args));
  const bytes=geometryBackingBytes(geometry);
  if(bytes>planned.bufferBytes)throw new Error('geometry-source-plan-exceeded:'+kind);
  for(const attribute of [...Object.values(geometry.attributes),geometry.index].filter(Boolean))admission.upload(attribute);
  admission.cpuReady(bytes);
  return geometry;
}

export function declaredArrayPayload(scope, scalarCount, label, typedBytes = 4, scratchCopies = 0) {
  if (!Number.isSafeInteger(scalarCount) || scalarCount < 0
      || ![1, 2, 4, 8].includes(typedBytes) || !Number.isSafeInteger(scratchCopies) || scratchCopies < 0)
    throw new Error('array-source-plan-unavailable');
  const bytes=scalarCount*(typedBytes+scratchCopies*8);
  if(!Number.isSafeInteger(bytes)||bytes<0)throw new Error('array-source-plan-unavailable');
  // GPU upload remains with the original attribute-cache admission seam.
  const ticket=scope.reserve({ownedCpuBytes:bytes},label);
  ticket?.commit();return ticket;
}

export function declaredTexturePayload(scope,width,height,label,mipmaps=true) {
  const bytes = textureSourceBytes(width, height, mipmaps);
  const ticket=scope.reserve({textureDeclaredBytes:bytes},label);ticket?.commit();return ticket;
}

export function textureSourceBytes(width, height, mipmaps = true) {
  if (![width, height].every(edge => Number.isSafeInteger(edge) && edge > 0 && edge <= 16384))
    throw new Error('texture-source-plan-unavailable');
  let w=width,h=height,bytes=0;
  do {bytes+=w*h*4;w=Math.max(1,Math.floor(w/2));h=Math.max(1,Math.floor(h/2));}
  while(mipmaps&&(w>1||h>1));
  if(mipmaps&&width*height>1)bytes+=4;
  if(!Number.isSafeInteger(bytes)||bytes<4)throw new Error('texture-source-plan-unavailable');
  return bytes;
}

// Pure, conservative serial-handoff preview of each original factory's fixed
// construction payload. Adding peaks overestimates sequential scratch, while
// actual scope reservations remain the allocation authority after retirement.
export function sourcePlan(programs) {
  const cost = { ownedCpuBytes: 0, bufferDeclaredBytes: 0, textureDeclaredBytes: 0, programs };
  const api = {
    geometry(kind, args = [], count = 1, wireframe = false) {
      const plan = geometrySourcePlan(kind, args);
      cost.ownedCpuBytes += plan.cpuPeakBytes * count;
      cost.bufferDeclaredBytes += plan.bufferBytes * count;
      if (wireframe) {
        const indices = (plan.indices || plan.vertices) * 2;
        const typed = indices * (plan.vertices >= 65535 ? 4 : 2);
        cost.ownedCpuBytes += (indices * 8 + typed) * count;
        cost.bufferDeclaredBytes += typed * count;
      }
      return api;
    },
    array(scalars, typedBytes = 4, scratchCopies = 0) {
      cost.ownedCpuBytes += scalars * (typedBytes + scratchCopies * 8);
      // Some declared arrays are uniforms/CPU-only; charging their bytes here
      // is a conservative prospective bound, not an extra live GPU ticket.
      cost.bufferDeclaredBytes += scalars * typedBytes;
      return api;
    },
    texture(width, height, mipmaps = true) { cost.textureDeclaredBytes += textureSourceBytes(width, height, mipmaps); return api; },
    stars(count) { return api.array(count * 7).array(3, 8); },
    glows(count) { return api.geometry('PlaneGeometry', [1, 1], count); },
    sky() { return api.geometry('SphereGeometry', [86, 32, 18]); },
    shock(count) { return api.geometry('PlaneGeometry', [2, 2]).array(count * 20); },
    add(other) { for (const key of Object.keys(cost)) cost[key] += other[key] || 0; return api; },
    result() {
      if (Object.values(cost).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('source-plan-unavailable');
      return { ...cost };
    }
  };
  return api;
}

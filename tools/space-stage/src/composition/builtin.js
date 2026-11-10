// SPDX-License-Identifier: MIT
// Registry factories remain the only owner of builtin geometry and effects.
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
async function sha256(value) {
  if (!globalThis.crypto?.subtle) throw new Error('composition-registry-hash-unavailable');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function sourceIdentity(registry) {
  const scenes = registry.catalog().map(def => ({id:def.id,label:def.label,category:def.category,stateVersion:def.stateVersion,
    aliases:def.aliases,preview:def.preview,params:def.params,camera:def.camera,capabilities:def.capabilities,quality:def.quality,
    ...(def.composition ? {composition:def.composition} : {})}));
  const profileHashes = {};
  for (const def of scenes) if (def.composition) profileHashes[def.id] =
    await sha256(JSON.stringify(canonical(def.composition.qualities.low)));
  return {registryHash:await sha256(JSON.stringify(scenes)),profileHashes};
}
export function planBuiltin(projection, values, registry, identity) {
  const indices = projection.ir.nodes.flatMap((node,index) => node.nodeType === 'builtinScene' ? [index] : []);
  if (!indices.length) {
    if (projection.builtinTarget) throw new Error('composition-builtin-target-unexpected');
    return null;
  }
  const index = indices[0], node = projection.ir.nodes[index], facts = projection.builtinTarget;
  if (!registry || !identity || indices.length !== 1 || node.parentIndex !== -1 || projection.canvas.scene3d
      || projection.ir.nodes.some(node => node.nodeType !== 'builtinScene' && node.space !== '2d'))
    throw new Error('composition-builtin-root-required');
  const constant = field => values.constants[node.constantSlots[field]];
  const definition = registry.get(constant('sceneId')), params = {};
  const parameter = (slot,index,kind) => {
    if (slot.nodeIndex !== indices[0] || !slot.builtinParameter) return;
    const spec=definition.params[slot.property],mapping=kind==='numeric'?node.propertySlots[slot.property]:node.constantSlots[slot.property];
    if (!spec || Object.hasOwn(params,slot.property) || (spec.type==='number') !== (kind==='numeric')
        || (kind==='numeric'? !Array.isArray(mapping)||mapping.length!==1||mapping[0]!==index : mapping!==index))
      throw new Error('composition-builtin-parameter-slot-invalid:'+slot.property);
    params[slot.property]=values[kind==='numeric'?'numeric':'constants'][index];
  };
  projection.ir.numericSlots.forEach((slot,index)=>parameter(slot,index,'numeric'));
  projection.ir.constantSlots.forEach((slot,index)=>parameter(slot,index,'constant'));
  if (Object.keys(params).length !== Object.keys(definition.params).length)
    throw new Error('composition-builtin-final-parameters-incomplete');
  const versionMapping=node.propertySlots.stateVersion,versionSlot=projection.ir.numericSlots[versionMapping?.[0]];
  if (!Array.isArray(versionMapping) || versionMapping.length!==1 || !versionSlot || versionSlot.nodeIndex!==index
      || versionSlot.property!=='stateVersion' || versionSlot.builtinParameter)
    throw new Error('composition-builtin-state-version-slot-invalid');
  const stateVersion = values.numeric[versionMapping[0]];
  if (!Number.isSafeInteger(stateVersion) || stateVersion < 1) throw new Error('composition-builtin-state-version-invalid');
  const normalized = registry.compositionState(constant('sceneId'), {stateVersion,params}, 'low');
  const {composition, profile} = normalized;
  if (!facts || facts.nodeIndex !== index || facts.nodeId !== node.id || facts.sceneId !== normalized.id
      || facts.stateVersion !== normalized.stateVersion || facts.registryHash !== identity.registryHash
      || projection.ir.sceneRegistryHash !== identity.registryHash || facts.profileHash !== identity.profileHashes[normalized.id]
      || facts.adapterId !== composition.adapterId || facts.adapterVersion !== composition.adapterVersion
      || facts.actualQuality !== 'low' || !same(facts.profile,profile) || !same(facts.clock,composition.clock)
      || !same(facts.finalParams,normalized.params) || facts.fit !== projection.target.fit)
    throw new Error('composition-builtin-source-projection-mismatch');
  const target = facts.targetFacts, allowance = facts.allowance;
  if (!target || !allowance || typeof target.monitorId !== 'string' || !target.monitorId
      || !Number.isSafeInteger(target.physicalWidth) || !Number.isSafeInteger(target.physicalHeight)
      || target.physicalWidth < 1 || target.physicalHeight < 1 || Math.max(target.physicalWidth,target.physicalHeight) > 16384
      || !Number.isFinite(target.deviceScale) || target.deviceScale < .5 || target.deviceScale > 8
      || !['low','medium','high'].includes(target.requestedQuality) || facts.requestedQuality !== target.requestedQuality
      || !Number.isSafeInteger(allowance.pixelCeiling) || allowance.pixelCeiling < 1
      || !Number.isSafeInteger(allowance.outputPixelRate) || allowance.outputPixelRate < 1
      || !Number.isSafeInteger(allowance.effectiveFps) || allowance.effectiveFps < 1 || allowance.effectiveFps > profile.fps
      || !Number.isSafeInteger(allowance.refreshHz) || allowance.refreshHz < 5 || allowance.refreshHz > 1000
      || allowance.frameDivisor !== Math.ceil(allowance.refreshHz/allowance.effectiveFps)
      || projection.target.budgetFps !== allowance.refreshHz/allowance.frameDivisor)
    throw new Error('composition-builtin-native-target-invalid');
  const nativePixels = Math.min(allowance.pixelCeiling,Math.floor(allowance.outputPixelRate/allowance.effectiveFps));
  const cssWidth = target.physicalWidth/target.deviceScale, cssHeight = target.physicalHeight/target.deviceScale;
  const dpr = Math.min(target.deviceScale,profile.dprCap,Math.sqrt(Math.min(profile.pixelBudget,nativePixels)/(cssWidth*cssHeight)));
  if (facts.nativePixelAllowance !== nativePixels || facts.cssWidth !== cssWidth || facts.cssHeight !== cssHeight
      || facts.effectiveDpr !== dpr || projection.target.width !== Math.floor(cssWidth*dpr)
      || projection.target.height !== Math.floor(cssHeight*dpr)
      || facts.target.width !== projection.target.width || facts.target.height !== projection.target.height)
    throw new Error('composition-builtin-raster-mismatch');
  return {index,definition:registry.get(normalized.id),params:normalized.params,profile,clock:composition.clock,facts};
}

export async function createBackground(THREE, context, scope, source, canvas, services, current) {
  const scene = new THREE.Scene(), baseline = source.definition.camera;
  const camera = new THREE.PerspectiveCamera(baseline.fov || 52,canvas.width/canvas.height,.05,900);
  if (baseline.position) camera.position.fromArray(baseline.position);
  else {
    const cp = Math.cos(baseline.phi || 0), radius = baseline.radius || 8;
    camera.position.set(Math.sin(baseline.theta || 0)*cp*radius,Math.sin(baseline.phi || 0)*radius,Math.cos(baseline.theta || 0)*cp*radius);
  }
  camera.lookAt(...(baseline.lookAt || [0,0,0])); camera.updateProjectionMatrix();
  const baseProjection = camera.projectionMatrix.clone(), fitMatrix = new THREE.Matrix4();
  scope.defer(() => scene.clear()); scope.beginAllocation();
  try {
    const instance = await source.definition.create({THREE,scene,camera,renderer:context.renderer,scope,
      resources:context.pagePort,params:source.params,quality:source.profile,signal:scope.signal,services});
    if (!instance || typeof instance.update !== 'function' || typeof instance.dispose !== 'function') throw new Error('composition-builtin-instance-invalid');
    scope.defer(() => instance.dispose()); scope.trackTree(scene);
    if (scope.signal.aborted || !current()) throw new DOMException('Composition cancelled','AbortError');
    if (scope.stats().unclaimedPreparedBuffers) throw new Error('composition-builtin-buffer-plan-unclaimed');
    instance.setParams?.(source.params); instance.setQuality?.(source.profile);
    return {scene,camera,instance,
      resize(width,height,left,top,boxWidth,boxHeight) {
        fitMatrix.set(boxWidth/width,0,0,(2*left+boxWidth)/width-1,
          0,boxHeight/height,0,1-(2*top+boxHeight)/height,0,0,1,0,0,0,0,1);
        camera.projectionMatrix.multiplyMatrices(fitMatrix,baseProjection);
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        instance.resize?.(canvas.width,canvas.height);
      }};
  } finally { scope.trackTree(scene); scope.endAllocation(); }
}

// Two pre-admitted backing arrays preserve the request until actual submit.
export function createInputSampler(clock, timeline, reset) {
  const capacity = clock.spectrumCapacity, scalar = capacity;
  const makeBank = () => ({data:new Float64Array(clock.inputBankLength),length:0,flags:{},rawTime:null,seek:false});
  let pending = makeBank(), committed = makeBank(), hasCommitted = false, hasPending = false, resets = 0;
  const number = (value,fallback=0) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('composition-builtin-input-nonfinite');
    return value;
  };
  function read(bank,paused=false,seek=bank.seek) {
    const a=bank.data;
    return {...bank.flags,paused,seek,sceneTime:a[scalar+5],time:a[scalar+6],position:a[scalar+7],
      dt:paused?0:a[scalar+8],dynamicDt:paused?0:a[scalar+9],realDt:paused?0:a[scalar+10],
      level:a[scalar],bands:{bass:a[scalar+1],mid:a[scalar+2],treble:a[scalar+3]},onset:a[scalar+4],spectrum:a.subarray(0,bank.length)};
  }
  function sample(frame) {
    // Validate explicit inputs even when pause retains the committed picture.
    const spectrum=frame.spectrum ?? frame.bands?.spectrum ?? [];
    if (!(Array.isArray(spectrum) || ArrayBuffer.isView(spectrum)) || spectrum.length > capacity)
      throw new Error('composition-builtin-spectrum-capacity');
    for (const value of spectrum) number(value);
    for (const field of ['level','time','sceneTime','position','dt','dynamicDt','realDt']) number(frame[field]);
    for (const field of ['bass','mid','treble']) number(frame.bands?.[field]);
    number(typeof frame.onset === 'boolean' ? Number(frame.onset) : frame.onset);
    if (frame.paused && !frame.seek && hasCommitted) {
      pending.data.set(committed.data);pending.length=committed.length;pending.flags={...committed.flags};
      pending.rawTime=committed.rawTime;pending.seek=false;hasPending=true;
      return read(pending,true,false);
    }
    const raw=number(frame.sceneTime,hasCommitted?committed.rawTime:0), remainder=raw%timeline.durationSeconds;
    const time=timeline.loop ? (remainder<0?remainder+timeline.durationSeconds:remainder) : Math.max(0,Math.min(raw,timeline.durationSeconds));
    if (hasPending && pending.rawTime === raw && !(frame.seek&&!pending.seek)) return read(pending,!!frame.paused);
    pending.data.fill(0); pending.length=spectrum.length; pending.data.set(spectrum);
    pending.data.set([number(frame.level),number(frame.bands?.bass),number(frame.bands?.mid),number(frame.bands?.treble),
      number(typeof frame.onset === 'boolean'?Number(frame.onset):frame.onset),time,time,number(frame.position,time),
      number(frame.dt),number(frame.dynamicDt,number(frame.dt)),number(frame.realDt,number(frame.dt))],scalar);
    pending.flags={playing:frame.playing,motionActive:frame.motionActive,reduced:frame.reduced};
    pending.rawTime=raw;pending.seek=!!frame.seek;hasPending=true;
    if (frame.seek) {reset();resets++;}
    return read(pending,!!frame.paused);
  }
  return {sample,commit(){if(!hasPending)return;const previous=committed;committed=pending;pending=previous;hasCommitted=true;hasPending=false;},
    stats:()=>({inputBytes:pending.data.byteLength+committed.data.byteLength,hasCommitted,hasPending,resets,
      committedTime:hasCommitted?committed.data[scalar+5]:null,pendingTime:hasPending?pending.data[scalar+5]:null})};
}

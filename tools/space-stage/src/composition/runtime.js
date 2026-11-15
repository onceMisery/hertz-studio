// SPDX-License-Identifier: MIT
import { buildNode, loadResource, loadTextRaster, updateNodeMaterial } from './nodes.js';
import { loadModelResource } from './model-node.js';
import { createScope } from '../scope.js';
import { createBackground, createInputSampler } from './builtin.js';
import { evaluateBinding, evaluateTrack } from './animation.js';
const MATRIX=1, LAYOUT=2, MATERIAL=4, VISIBILITY=8, RESOURCE=16, GEOMETRY=32, ALL=63;
const modelConstructionBytes = facts => facts.input.encodedBytes + facts.input.binBytes + facts.input.jsonBytes * 2
  + (facts.resources.animationCpuBytes || 0) + (facts.resources.skinCpuBytes || 0);
const outputVertex = `varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`;
const outputFragment = `uniform sampler2D inputMap;uniform float brightness;uniform float contrast;
  uniform float saturation;uniform float hue;uniform sampler2D glowMap;uniform bool hasGlow;uniform float glowStrength;
  varying vec2 vUv;
  vec3 hueRotate(vec3 c,float a){float s=sin(a),v=cos(a);
    return clamp(vec3(
      dot(c,vec3(0.213+v*0.787-s*0.213,0.715-v*0.715-s*0.715,0.072-v*0.072+s*0.928)),
      dot(c,vec3(0.213-v*0.213+s*0.143,0.715+v*0.285+s*0.140,0.072-v*0.072-s*0.283)),
      dot(c,vec3(0.213-v*0.213-s*0.787,0.715-v*0.715+s*0.715,0.072+v*0.928+s*0.072))),0.0,1.0);}
  void main(){
    vec3 color=texture2D(inputMap,vUv).rgb;
    if(hasGlow)color+=texture2D(glowMap,vUv).rgb*glowStrength;
    color+=brightness;
    color=(color-0.5)*contrast+0.5;
    color=mix(vec3(dot(color,vec3(0.2126,0.7152,0.0722))),color,saturation);
    color=hueRotate(color,hue);
    gl_FragColor=vec4(clamp(color,0.0,1.0),1.0);
  #include <colorspace_fragment>
  }`;
const thresholdFragment = `uniform sampler2D inputMap;uniform float threshold;varying vec2 vUv;
  void main(){vec3 color=texture2D(inputMap,vUv).rgb;
    float luma=dot(color,vec3(0.2126,0.7152,0.0722));
    float weight=clamp((luma-threshold)/max(1.0-threshold,0.001),0.0,1.0);
    gl_FragColor=vec4(color*weight,1.0);}`;
const blurFragment = `uniform sampler2D inputMap;uniform vec2 blurStep;varying vec2 vUv;
  void main(){vec3 color=texture2D(inputMap,vUv).rgb*0.2270270270;
    color+=texture2D(inputMap,vUv+blurStep*1.3846153846).rgb*0.3162162162;
    color+=texture2D(inputMap,vUv-blurStep*1.3846153846).rgb*0.3162162162;
    color+=texture2D(inputMap,vUv+blurStep*3.2307692308).rgb*0.0702702703;
    color+=texture2D(inputMap,vUv-blurStep*3.2307692308).rgb*0.0702702703;
    gl_FragColor=vec4(color,1.0);}`;
function validateTextTextureSize(context, plan) {
  if (!plan.textRasters.length) return;
  const maximum = context.renderer.capabilities.maxTextureSize;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || plan.textRasters.some(requirement =>
    requirement.widthPx > maximum || requirement.heightPx > maximum))
    throw new Error('composition-adapter-unavailable:text-texture-size');
}
function reserveAll(context, scope, plan, generation) {
  validateTextTextureSize(context, plan);
  const sources = new Map(), reserved = [], programTickets = [], unclaimedPrivate = new Set();
  const nodeScopes=plan.nodePlans.map(spec=>createScope({resources:context.pagePort,generation,
    preparedBuffersRequired:spec.node.nodeType==='builtinScene'}));
  scope.defer(()=>nodeScopes.forEach(nodeScope=>nodeScope.dispose()));
  const require = (resources, source) => {
    const ticket = context.pagePort?.require(resources, source, generation, 'bounded-estimate');
    if (ticket) reserved.push(ticket); return ticket;
  };
  try {
    const targetTicket = require({ renderTargetDeclaredBytes: plan.pixels * (plan.builtin || plan.has3d ? 12 : 8) }, 'Composition planned linear RGBA16F/depth target');
    if (targetTicket) unclaimedPrivate.add(targetTicket);
    const glowTicket = plan.outputGlow
      ? require({ renderTargetDeclaredBytes: plan.outputGlow.width * plan.outputGlow.height * 8 }, 'Composition glow half-resolution RGBA8 surfaces')
      : null;
    if (glowTicket) unclaimedPrivate.add(glowTicket);
    for (let index=0; index<plan.resources.programs; index++) programTickets.push(require({programs:1}, 'Composition bounded shader program cache miss'));
    const outputPlan = scope.bufferPlan(92,92,'Composition final output quad');
    const inputTicket = plan.builtin ? require({ownedCpuBytes:plan.builtin.clock.inputBytes},'Composition pending/committed input arrays') : null;
    if(inputTicket)unclaimedPrivate.add(inputTicket);
    for (const spec of plan.nodePlans) {
      if (spec.node.nodeType === 'builtinScene') {
        for(const buffer of plan.builtin.profile.sourceResources.buffers)
          nodeScopes[spec.index].prepareBufferPlan(buffer.id,buffer.cpuPeakBytes,buffer.bufferBytes);
      } else if (spec.node.nodeType === 'model') {
        const facts = spec.resources.asset.modelFacts;
        spec.bufferPlan = nodeScopes[spec.index].bufferPlan(facts.resources.cpuBackingBytes,
          facts.resources.gpuBufferBytes,'Composition static model buffers');
      } else if (spec.node.nodeType !== 'group') {
        const bytes = spec.node.nodeType === 'particles' ? spec.count * 20 : 92;
        spec.bufferPlan = nodeScopes[spec.index].bufferPlan(bytes,bytes,'Composition fixed node buffers');
      }
    }
    for (const requirement of plan.requirements) {
      if (context.pool.has(requirement.identity)) continue;
      let admissions;
      if (requirement.kind === 'font') admissions={cpu:require({ownedCpuBytes:requirement.fontMetadata.cpuBudgetBytes},'Composition prepared same-package font')};
      else if (requirement.kind === 'model') {
        const spec = plan.nodePlans.find(item => item.resources.asset === requirement);
        const textured = requirement.modelFacts.profile === 'static-pbr-texture-v1'
          || requirement.modelFacts.profile === 'static-ktx2-texture-v1';
        admissions={cpu:require({ownedCpuBytes:modelConstructionBytes(requirement.modelFacts)+(spec.materialBytes||0)},'Composition static model construction'),
          ...(textured ? {
            decode:require({decodeReservedBytes:requirement.textureUploadBytes},'Composition model texture decode window'),
            upload:require({textureDeclaredBytes:requirement.textureUploadBytes},'Composition model texture upload')} : {}),
          bufferPlan:spec.bufferPlan, renderer:context.renderer};
      } else {
        const bytes=requirement.width*requirement.height*4;
        admissions={decode:require({decodeReservedBytes:requirement.kind==='video'?bytes*3:bytes,
          ...(requirement.kind==='video'?{decoderLeases:1}:{})},'Composition actual media decode reservation'),
          upload:require({textureDeclaredBytes:bytes},'Composition per-context texture upload')};
      }
      sources.set(requirement,admissions);
    }
    for (const requirement of plan.textRasters) if (!context.pool.has(requirement.identity)) {
      const pixels = requirement.widthPx * requirement.heightPx;
      sources.set(requirement, {raster: require({canvases:1, drawingBufferPixels:pixels,
        ownedCpuBytes:pixels*4, textureDeclaredBytes:pixels*4}, 'Composition shared prepared text raster')});
    }
    // All actual reservations above complete synchronously before any loader
    // can start. Source tickets transfer to the pool adapter at acquisition.
    const unclaimed = new Set(sources.keys());
    scope.defer(() => {
      for (const requirement of unclaimed) for (const ticket of Object.values(sources.get(requirement)))
        if (typeof ticket?.release === 'function') ticket.release({apiReleased:true,allocationEnded:true});
      for (const ticket of programTickets) ticket?.release({apiReleased:true,allocationEnded:true});
      for (const ticket of unclaimedPrivate) ticket.release({apiReleased:true,allocationEnded:true});
    });
    return { sources, unclaimed, unclaimedPrivate, targetTicket, glowTicket, inputTicket, outputPlan, programTickets, nodeScopes };
  } catch (error) {
    nodeScopes.forEach(nodeScope=>nodeScope.dispose());
    for (const ticket of reserved) ticket.release({apiReleased:true,allocationEnded:true});
    throw error;
  }
}
export async function createCompositionRuntime(THREE, context, scope, plan, options = {}) {
  const signal = scope.signal, generation = options.generation, leases = new Map(), values = new Map();
  let disposed = false, target = null, targetTicket = null, glowA = null, glowB = null, sceneTime = 0, frameReady = false, outputDirty=true;
  let timelineBase = null, bindingStacks = [], inputValues = null;
  let bindingErrors = 0;
  let updateGeneration=0, pendingController=null, visualTime=null, mediaShouldPlay=false;
  const dirty=new Uint32Array(plan.ir.nodes.length), localDirty=new Uint8Array(plan.ir.nodes.length), worldDirty=new Uint8Array(plan.ir.nodes.length);
  const work={slotChanges:0,constantChanges:0,resourceChanges:0,outputInvalidations:0,renders:0,
    matrixUpdates:new Uint32Array(plan.ir.nodes.length),materialUpdates:new Uint32Array(plan.ir.nodes.length),
    worldMatrixUpdates:new Uint32Array(plan.ir.nodes.length),nodeRebuilds:new Uint32Array(plan.ir.nodes.length)};
  const irBytes=JSON.stringify(plan.ir), canvasBytes=JSON.stringify(plan.projection.canvas), timelineBytes=JSON.stringify(plan.projection.timeline);
  const constantDependencies=plan.ir.constantSlots.map(slot=>plan.ir.constantDependencies[slot.nodeIndex][slot.property]);
  const resourceDependencies=new Map(plan.ir.resourceUses.map((use,index)=>[`${use.nodeIndex}:${use.field}`,plan.ir.resourceDependencies[index]]));
  const renderer = context.renderer, scene = new THREE.Scene(), root = new THREE.Group(); scene.add(root);
  // The runtime updates only dirty branches. Three must not force every world
  // matrix through Scene.updateMatrixWorld on a static supplemental frame.
  scene.matrixAutoUpdate=false; scene.matrixWorldAutoUpdate=false;
  const camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1, 1); camera.position.z = 1;
  // A composition has one fixed 3D layer below the 2D painter order. The
  // compiler still owns the camera; the runtime only binds it to this context.
  const modelScene = plan.has3d ? new THREE.Scene() : null;
  const modelCamera = plan.has3d
    ? new THREE.PerspectiveCamera(plan.camera.fovDegrees, plan.projection.canvas.width / plan.projection.canvas.height,
      plan.camera.near, plan.camera.far) : null;
  if (modelCamera) {
    modelCamera.position.fromArray(plan.camera.position);
    modelCamera.lookAt(new THREE.Vector3().fromArray(plan.camera.target));
    modelCamera.updateMatrixWorld(true);
    // Ambient-only avoids an unquantified directional specular addition on
    // authored PBR textures; the compiler does not publish a light rig yet.
    modelScene.add(new THREE.AmbientLight(0xffffff, Math.PI));
  }
  const allocation = reserveAll(context,scope,plan,generation);
  let background = null, inputSampler = null;
  // This owner must exist before the first loader/factory can throw.
  scope.defer(()=>{inputSampler=null;allocation.inputTicket?.release({apiReleased:true,allocationEnded:true});});
  if(plan.builtin) {
    inputSampler=createInputSampler(plan.builtin.clock,plan.projection.timeline,()=>background?.instance.resetHistory?.());
    allocation.inputTicket?.commit({ownedCpuBytes:plan.builtin.clock.inputBytes});
    allocation.unclaimedPrivate.delete(allocation.inputTicket);
  }
  function invalidate(){outputDirty=true;options.onInvalidate?.();}
  // Every requirement was admitted as one target plan before the first load.
  const loading = [];
  for (const requirement of plan.requirements) {
    const lease = context.pool.acquire(requirement.identity, { signal, generation, isCurrent: options.isCurrent,
      load: ({ signal, generation }) => requirement.kind === 'model'
        ? loadModelResource(requirement, signal, allocation.sources.get(requirement))
        : loadResource(THREE, context, requirement, signal, generation, invalidate, allocation.sources.get(requirement)),
      releaseValue: value => value.release() });
    if (!lease) throw new Error('composition-resource-pool-exhausted');
    allocation.unclaimed.delete(requirement);
    scope.lease(lease); leases.set(requirement.key, lease);
    const task = lease.ready.then(value => { values.set(requirement.key, value); });
    task.catch(() => {}); loading.push(task);
  }
  await Promise.all(loading);
  if (signal.aborted) throw new DOMException('Composition cancelled', 'AbortError');
  const textLoading = [];
  for (const spec of plan.nodePlans) if (spec.node.nodeType === 'text') {
    const requirement = spec.textRaster, nodeScope = allocation.nodeScopes[spec.index];
    const lease = context.pool.acquire(requirement.identity, {signal:nodeScope.signal, generation, isCurrent:options.isCurrent,
      load: ({signal, generation}) => loadTextRaster(THREE, context, requirement, signal, generation, allocation.sources.get(requirement)?.raster),
      releaseValue: value => value.release()});
    if (!lease) throw new Error('composition-resource-pool-exhausted');
    allocation.unclaimed.delete(requirement); nodeScope.lease(lease); spec.textRasterLease = lease;
    textLoading.push(lease.ready);
  }
  await Promise.all(textLoading);
  if (signal.aborted) throw new DOMException('Composition cancelled', 'AbortError');
  function nodeAssets(spec, sourceValues=values){return Object.fromEntries(Object.entries(spec.resources).map(([field, requirement])=>[field,sourceValues.get(requirement.key)]));}
  if(plan.builtin)background=await createBackground(THREE,context,allocation.nodeScopes[plan.builtin.index],plan.builtin,
    plan.projection.canvas,options.services||{},()=>!signal.aborted&&(!options.isCurrent||options.isCurrent(generation)));
  const nodes = plan.nodePlans.map(spec => spec.node.nodeType==='builtinScene'
    ? {spec,object:new THREE.Group(),background:true}
    : buildNode(THREE, context, allocation.nodeScopes[spec.index], spec,nodeAssets(spec),generation));
  for (const index of plan.ir.painterOrder) {
    const node = nodes[index], parent = node.spec.node.parentIndex;
    if(node.background)continue;
    const spaceRoot = node.spec.node.space === '3d' ? modelScene : root;
    (parent < 0 ? spaceRoot : nodes[parent].object).add(node.object);
  }
  // renderOrder follows compiled painter order, including non-index child order.
  plan.ir.painterOrder.forEach((index, order) => { nodes[index].object.renderOrder = nodes[index].spec.node.nodeType === 'group' ? 0 : order + 1; });
  const outputScene = new THREE.Scene(), outputCamera = new THREE.Camera();
  const outputGeometry = scope.track(new THREE.BufferGeometry()), outputPlan = allocation.outputPlan;
  outputGeometry.setAttribute('position', outputPlan.upload(new THREE.BufferAttribute(new Float32Array([-1,-1,0, 1,-1,0, -1,1,0, 1,1,0]), 3)));
  outputGeometry.setAttribute('uv', outputPlan.upload(new THREE.BufferAttribute(new Float32Array([0,0, 1,0, 0,1, 1,1]), 2)));
  const outputIndex = outputPlan.upload(new THREE.BufferAttribute(new Uint16Array([0,1,2, 2,1,3]), 1));
  outputGeometry.setIndex(outputIndex);
  outputPlan.cpuReady(92);
  const outputMaterial = scope.track(new THREE.ShaderMaterial({ vertexShader: outputVertex, fragmentShader: outputFragment,
    depthTest: false, depthWrite: false, toneMapped: false, uniforms: { inputMap: { value: null },
      glowMap: { value: null }, hasGlow: { value: false }, glowStrength: { value: 0 },
      brightness: { value: 0 }, contrast: { value: 1 }, saturation: { value: 1 }, hue: { value: 0 } } }));
  function applyOutputEffects() {
    const effect = plan.outputEffects?.[0];
    const uniforms = outputMaterial.uniforms;
    uniforms.brightness.value = effect?.brightness ?? 0;
    uniforms.contrast.value = effect?.contrast ?? 1;
    uniforms.saturation.value = effect?.saturation ?? 1;
    uniforms.hue.value = (effect?.hueDegrees ?? 0) * Math.PI / 180;
    uniforms.hasGlow.value = !!plan.outputGlow;
    uniforms.glowStrength.value = plan.outputGlow?.strength ?? 0;
    if (plan.outputGlow) {
      thresholdMaterial.uniforms.threshold.value = plan.outputGlow.threshold;
      blurMaterial.uniforms.radius.value = plan.outputGlow.radius;
    }
    outputDirty = true;
  }
  const glowScene = new THREE.Scene(), glowMesh = new THREE.Mesh(outputGeometry, null);
  glowScene.add(glowMesh);
  const thresholdMaterial = scope.track(new THREE.ShaderMaterial({ vertexShader: outputVertex, fragmentShader: thresholdFragment,
    depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: { inputMap: { value: null }, threshold: { value: 0.8 } } }));
  const blurMaterial = scope.track(new THREE.ShaderMaterial({ vertexShader: outputVertex, fragmentShader: blurFragment,
    depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: { inputMap: { value: null }, blurStep: { value: new THREE.Vector2() }, radius: { value: 8 } } }));
  applyOutputEffects();
  outputScene.add(new THREE.Mesh(outputGeometry, outputMaterial));
  const clearColor = new THREE.Color(plan.projection.canvas.background), viewport = new THREE.Vector2(), canvasClip=new THREE.Vector4();
  const savedScissor=new THREE.Vector4(), savedClear=new THREE.Color();
  let videos = [...values.values()].filter(value => value.video);
  function pause() { for (const value of videos) value.video.pause(); }
  scope.listen(document, 'visibilitychange', () => { if (document.hidden) pause(); });
  scope.defer(()=>pendingController?.abort());
  function applyNode(node, mask=ALL, changeLocal=true) {
    if(node.background)return;
    const spec = node.spec, n = spec.number, parent = spec.node.parentIndex < 0 ? null : nodes[spec.node.parentIndex];
    if (mask & (MATERIAL|VISIBILITY)) {
      node.opacity = (parent?.opacity ?? 1) * n('opacity');
      node.object.visible = (parent?.object.visible ?? true) && spec.constant('visible');
      if(node.material){node.material.uniforms.opacity.value=node.opacity;updateNodeMaterial(THREE,node,nodeAssets(spec));}
      if(node.modelMaterials){
        for(const material of node.modelMaterials){
          const base=material.userData.modelBaseOpacity??1,next=base*node.opacity;
          if(material.opacity!==next)material.opacity=next;
          const transparent=next<1||!!material.userData.modelAuthoredTransparent;
          if(material.transparent!==transparent){material.transparent=transparent;material.needsUpdate=true;}
          const depthWrite=next<1?false:material.userData.modelAuthoredDepthWrite!==false;
          if(material.depthWrite!==depthWrite)material.depthWrite=depthWrite;
        }
      }
      work.materialUpdates[spec.index]++;
    }
    if (!changeLocal) return;
    if (spec.node.space === '3d') {
      const vector = name => spec.node.propertySlots[name].map(slot => plan.values.numeric[slot]);
      const position = vector('position'), rotation = vector('rotation'), scale = vector('scale');
      const euler = new THREE.Euler(rotation[0] * Math.PI / 180, rotation[1] * Math.PI / 180,
        rotation[2] * Math.PI / 180, 'XYZ');
      node.object.matrixAutoUpdate = false;
      node.object.matrix.compose(new THREE.Vector3(position[0], position[1], position[2]),
        new THREE.Quaternion().setFromEuler(euler), new THREE.Vector3(scale[0], scale[1], scale[2]));
      node.object.matrixWorldNeedsUpdate = true;
      work.matrixUpdates[spec.index]++;
      return;
    }
    const width = n('width'), height = n('height');
    const angle = n('rotation') * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle), sx = n('scaleX'), sy = n('scaleY');
    const x = n('x') - cosine * sx * width * n('anchorX') + sine * sy * height * n('anchorY');
    const y = n('y') - sine * sx * width * n('anchorX') - cosine * sy * height * n('anchorY');
    node.object.matrixAutoUpdate = false;
    if (spec.node.nodeType === 'group' || node.particles) node.object.matrix.set(cosine*sx,-sine*sy,0,x, sine*sx,cosine*sy,0,y, 0,0,1,0, 0,0,0,1);
    else node.object.matrix.set(cosine*sx*width,-sine*sy*height,0,x, sine*sx*width,cosine*sy*height,0,y, 0,0,1,0, 0,0,0,1);
    node.object.matrixWorldNeedsUpdate = true;
    work.matrixUpdates[spec.index]++;
    if (node.material) {
      const resource = spec.resources.asset;
      if (spec.node.nodeType === 'image' && resource) {
        const fit = spec.constant('fit'), ratio = resource.width / resource.height, boxRatio = width / height;
        node.material.uniforms.uvScale.value.set(1,1);node.material.uniforms.uvOffset.value.set(0,0);
        if (fit === 'cover') {
          const uvX = Math.min(1, boxRatio / ratio), uvY = Math.min(1, ratio / boxRatio);
          node.material.uniforms.uvScale.value.set(uvX,uvY); node.material.uniforms.uvOffset.value.set((1-uvX)/2,(1-uvY)/2);
        } else if (fit === 'contain') {
          const drawWidth = ratio > boxRatio ? width : height * ratio, drawHeight = ratio > boxRatio ? width / ratio : height;
          const dx = (width-drawWidth)/2, dy = (height-drawHeight)/2;
          node.object.matrix.set(cosine*sx*drawWidth,-sine*sy*drawHeight,0,x+cosine*sx*dx-sine*sy*dy,
            sine*sx*drawWidth,cosine*sy*drawHeight,0,y+sine*sx*dx+cosine*sy*dy,0,0,1,0,0,0,0,1);
        }
      }
    }
  }
  plan.ir.painterOrder.forEach(index => applyNode(nodes[index]));
  function refreshTimeline() {
    const animated = plan.ir.tracks.length || plan.ir.bindings.length;
    timelineBase = animated ? Float64Array.from(plan.values.numeric) : null;
    bindingStacks = plan.ir.bindings.map(binding => new Float64Array(binding.maxStack + 1));
    inputValues = new Float64Array(plan.ir.inputs.length);
  }
  function inputAt(name, frame, time) {
    if (name.startsWith('spectrum')) {
      const spectrum = frame.spectrum ?? frame.bands?.spectrum, index = Number(name.slice(8));
      const value = (Array.isArray(spectrum) || ArrayBuffer.isView(spectrum)) ? spectrum[index] : undefined;
      return Number.isFinite(value) ? value : 0;
    }
    let value;
    if (name === 'energy') value = frame.level ?? frame.energy;
    else if (name === 'bass') value = frame.bands?.bass ?? frame.bass;
    else if (name === 'mid') value = frame.bands?.mid ?? frame.mid;
    else if (name === 'high') value = frame.bands?.treble ?? frame.high;
    else if (name === 'pointerX') value = frame.pointer?.x ?? frame.pointerX;
    else if (name === 'pointerY') value = frame.pointer?.y ?? frame.pointerY;
    else if (name === 'sceneTime') value = time;
    else value = frame[name];
    return Number.isFinite(value) ? value : 0;
  }
  function applyTimeline(time, frame) {
    const numeric = plan.values.numeric, changed = [];
    for (const track of plan.ir.tracks) {
      numeric[track.targetSlot] = evaluateTrack(track.keys, time);
      // Always re-apply: the previous frame may hold a different sampled value.
      changed.push(track.targetSlot);
    }
    if (plan.ir.bindings.length) {
      for (let index = 0; index < plan.ir.inputs.length; index++) {
        inputValues[index] = inputAt(plan.ir.inputs[index], frame, time);
      }
      for (const [index, binding] of plan.ir.bindings.entries()) {
        const value = evaluateBinding(binding, inputValues, plan.bindingParameters[index], bindingStacks[index]);
        if (value === null || !Number.isFinite(value)) { bindingErrors++; continue; }
        const current = numeric[binding.targetSlot];
        const next = binding.mode === 'add' ? current + value
          : binding.mode === 'multiply' ? current * value : value;
        if (!Number.isFinite(next)) continue;
        numeric[binding.targetSlot] = next;
        changed.push(binding.targetSlot);
      }
    }
    for (const slot of changed) {
      const dependency = plan.ir.slotDependencies[slot];
      for (const affected of dependency.nodes) applyNode(nodes[affected.nodeIndex], affected.mask);
      if (dependency.output) outputDirty = true;
    }
    // Plan diffs compare authored/public values, not the sampled track frame.
    numeric.set(timelineBase);
  }
  refreshTimeline();
  function canApplyPlan(next){
    if(plan.builtin||next.builtin)return false;
    const old=plan.projection, candidate=next.projection, a=old.target,b=candidate.target;
    return candidate.semanticKey===old.semanticKey&&candidate.sessionId===old.sessionId&&candidate.generation===old.generation
      && (candidate.clockDomain||candidate.sessionId)===(old.clockDomain||old.sessionId)
      && a.width===b.width&&a.height===b.height&&(a.fit||'cover')===(b.fit||'cover')
      && a.budgetFps===b.budgetFps&&a.budgetAllocationRevision===b.budgetAllocationRevision
      && JSON.stringify(next.ir)===irBytes&&JSON.stringify(candidate.canvas)===canvasBytes&&JSON.stringify(candidate.timeline)===timelineBytes;
  }
  function diff(next){
    const masks=new Uint32Array(nodes.length), locals=new Uint8Array(nodes.length), worlds=new Uint8Array(nodes.length), rebuilds=new Set(), clips=new Set();
    let slots=0,constants=0,resources=0,output=false;
    function dependency(dep){
      for(const affected of dep.nodes)masks[affected.nodeIndex]|=affected.mask;
      output ||= dep.output;
    }
    function matrix(index){
      locals[index]=1;worlds[index]=1;
      for(const descendant of plan.ir.matrixDependents[index])worlds[descendant]=1;
    }
    if (JSON.stringify(plan.bindingParameters) !== JSON.stringify(next.bindingParameters)) {
      for (const binding of plan.ir.bindings) {
        dependency(plan.ir.slotDependencies[binding.targetSlot]); slots++;
      }
    }
    for(let index=0;index<plan.values.numeric.length;index++)if(plan.values.numeric[index]!==next.values.numeric[index]){
      slots++;const slot=plan.ir.numericSlots[index],type=plan.ir.nodes[slot.nodeIndex].nodeType,dep=plan.ir.slotDependencies[index];dependency(dep);
      if(dep.nodes.some(node=>node.nodeIndex===slot.nodeIndex&&(node.mask&MATRIX)))matrix(slot.nodeIndex);
      if(type==='text'&&['width','height','fontSize','lineHeight'].includes(slot.property)
        ||type==='particles'&&['count','seed'].includes(slot.property)
        ||type==='model'&&slot.property==='opacity')rebuilds.add(slot.nodeIndex);
    }
    for(let index=0;index<plan.values.constants.length;index++)if(plan.values.constants[index]!==next.values.constants[index]){
      constants++;const slot=plan.ir.constantSlots[index],type=plan.ir.nodes[slot.nodeIndex].nodeType,dep=constantDependencies[index];dependency(dep);
      if(dep.nodes.some(node=>node.nodeIndex===slot.nodeIndex&&(node.mask&MATRIX))||type==='image'&&slot.property==='fit')matrix(slot.nodeIndex);
      if(type==='text'&&['text','color','align'].includes(slot.property))rebuilds.add(slot.nodeIndex);
      else if(type==='model'&&slot.property==='animationClip')clips.add(slot.nodeIndex);
    }
    for(let index=0;index<nodes.length;index++){
      const previous=plan.nodePlans[index].resources,replacement=next.nodePlans[index].resources;
      for(const field of new Set([...Object.keys(previous),...Object.keys(replacement)])){
        const old=previous[field],current=replacement[field];
        if(old?.key===current?.key&&old?.assetId===current?.assetId)continue;
        resources++;const dep=resourceDependencies.get(`${index}:${field}`);
        // Optional public asset slots are fixed compiler targets too. Their
        // final ResourceUse supplies the typed use even when absent at author defaults.
        if(dep)dependency(dep);else{
          if(!plan.ir.publicProperties.some(property=>property.target.kind==='asset'&&property.target.nodeIndex===index&&property.target.field===field))
            throw new Error('composition-resource-dependency-missing');
          masks[index]|=RESOURCE|MATERIAL|(current?.usage==='font'?LAYOUT:0);output=true;
        }
        if(plan.ir.nodes[index].nodeType==='text')rebuilds.add(index);
        if(plan.ir.nodes[index].nodeType==='model')rebuilds.add(index);
        if(plan.ir.nodes[index].nodeType==='image')matrix(index);
      }
      if (plan.ir.nodes[index].nodeType === 'text'
          && plan.nodePlans[index].textRaster.key !== next.nodePlans[index].textRaster.key) {
        rebuilds.add(index); masks[index] |= LAYOUT | MATERIAL; output = true;
      }
    }
    return {masks,locals,worlds,rebuilds,clips,slots,constants,resources,output,changed:!!(slots||constants||resources||rebuilds.size||clips.size)};
  }
  function reserveDelta(next,changes){
    validateTextTextureSize(context, next);
    const newScopes=new Map(), sourceTickets=new Map(), unclaimedSources=new Set(), unusedPrivate=new Set(), programTickets=[];
    const reserved=[];const require=(amount,label)=>{const ticket=context.pagePort.require(amount,label,generation,'bounded-estimate');reserved.push(ticket);return ticket;};
    const amount={programs:0,ownedCpuBytes:0,bufferDeclaredBytes:0,textureDeclaredBytes:0,decodeReservedBytes:0,decoderLeases:0,canvases:0,drawingBufferPixels:0};
    const variants=new Set();let modelPrograms=0;
    for(const index of changes.rebuilds){const spec=next.nodePlans[index];
      if(spec.node.nodeType==='model'){
        const facts=spec.resources.asset.modelFacts;
        modelPrograms+=Math.max(1, facts.resources?.programCount||facts.materials?.length||1);
        amount.ownedCpuBytes+=spec.materialBytes||0;
        variants.add('model');continue;
      }
      const bytes=spec.node.nodeType==='particles'?spec.count*20:92;
      amount.ownedCpuBytes+=bytes;amount.bufferDeclaredBytes+=bytes;variants.add(spec.node.nodeType==='particles'?'particles':'planar');
    }
    amount.programs=Math.max(0,variants.size-allocation.programTickets.length,modelPrograms);
    for(const requirement of next.requirements)if(!leases.has(requirement.key)&&!context.pool.has(requirement.identity)){
      if(requirement.kind==='font')amount.ownedCpuBytes+=requirement.fontMetadata.cpuBudgetBytes;
      else if(requirement.kind==='model'){
        amount.ownedCpuBytes+=modelConstructionBytes(requirement.modelFacts)+requirement.modelFacts.resources.cpuBackingBytes;
        amount.bufferDeclaredBytes+=requirement.modelFacts.resources.gpuBufferBytes;
        if(requirement.modelFacts.profile==='static-pbr-texture-v1'){
          amount.textureDeclaredBytes+=requirement.textureUploadBytes;
          amount.decodeReservedBytes+=requirement.textureUploadBytes;
        }
      }
      else{const bytes=requirement.width*requirement.height*4;amount.textureDeclaredBytes+=bytes;amount.decodeReservedBytes+=bytes*(requirement.kind==='video'?3:1);if(requirement.kind==='video')amount.decoderLeases++;}
    }
    const newRasters = new Map();
    for (const index of changes.rebuilds) {
      const requirement = next.nodePlans[index].textRaster;
      if (requirement && !context.pool.has(requirement.identity)) newRasters.set(requirement.key, requirement);
    }
    for (const requirement of newRasters.values()) {
      const pixels = requirement.widthPx * requirement.heightPx;
      amount.ownedCpuBytes += pixels*4; amount.textureDeclaredBytes += pixels*4;
      amount.drawingBufferPixels += pixels; amount.canvases++;
    }
    const forecast=context.pagePort.preflight(amount,[]);if(!forecast.ok)throw new Error(forecast.reason);
    function cleanup(){
      for(const nodeScope of newScopes.values())nodeScope.dispose();
      for(const key of unclaimedSources)for(const ticket of Object.values(sourceTickets.get(key)))
        if(typeof ticket?.release==='function')ticket.release({apiReleased:true,allocationEnded:true});
      for(const ticket of unusedPrivate)ticket.release({apiReleased:true,allocationEnded:true});
      for(const ticket of programTickets)ticket.release({apiReleased:true,allocationEnded:true});
    }
    try{
      for(let index=0;index<amount.programs;index++)programTickets.push(require({programs:1},'Composition changed-node shader cache miss'));
      for(const index of changes.rebuilds){const spec=next.nodePlans[index],nodeScope=createScope({resources:context.pagePort,generation});newScopes.set(index,nodeScope);
        if(spec.node.nodeType==='model'){
          const facts=spec.resources.asset.modelFacts;
          spec.bufferPlan=nodeScope.bufferPlan(facts.resources.cpuBackingBytes,facts.resources.gpuBufferBytes,'Composition changed static model buffers');
        } else {
          const bytes=spec.node.nodeType==='particles'?spec.count*20:92;
          spec.bufferPlan=nodeScope.bufferPlan(bytes,bytes,'Composition changed-node fixed buffers');
        }
      }
      for(const requirement of next.requirements)if(!leases.has(requirement.key)&&!context.pool.has(requirement.identity)){
        let tickets;
        if(requirement.kind==='font')tickets={cpu:require({ownedCpuBytes:requirement.fontMetadata.cpuBudgetBytes},'Composition changed prepared same-package font')};
        else if(requirement.kind==='model'){
          const spec=next.nodePlans.find(item=>item.resources.asset===requirement);
          const textured=requirement.modelFacts.profile==='static-pbr-texture-v1'||requirement.modelFacts.profile==='static-ktx2-texture-v1';
          tickets={cpu:require({ownedCpuBytes:modelConstructionBytes(requirement.modelFacts)+(spec.materialBytes||0)},'Composition changed static model construction'),
            ...(textured?{
              decode:require({decodeReservedBytes:requirement.textureUploadBytes},'Composition changed model texture decode window'),
              upload:require({textureDeclaredBytes:requirement.textureUploadBytes},'Composition changed model texture upload')}:{}),
            bufferPlan:spec.bufferPlan, renderer:context.renderer};
        }
        else{const bytes=requirement.width*requirement.height*4;tickets={decode:require({decodeReservedBytes:bytes*(requirement.kind==='video'?3:1),...(requirement.kind==='video'?{decoderLeases:1}:{})},'Composition changed actual-media decoder'),upload:require({textureDeclaredBytes:bytes},'Composition changed per-context texture')};}
        sourceTickets.set(requirement.key,tickets);unclaimedSources.add(requirement.key);
      }
      for (const requirement of newRasters.values()) {
        const pixels = requirement.widthPx * requirement.heightPx;
        const tickets = {raster:require({canvases:1,drawingBufferPixels:pixels,ownedCpuBytes:pixels*4,
          textureDeclaredBytes:pixels*4}, 'Composition changed shared text raster')};
        sourceTickets.set(requirement.key, tickets); unclaimedSources.add(requirement.key);
      }
      return {newScopes,sourceTickets,unclaimedSources,unusedPrivate,programTickets,cleanup};
    }catch(error){cleanup();for(const ticket of reserved)ticket.release({apiReleased:true,allocationEnded:true});throw error;}
  }
  function cancelPreparation(){updateGeneration++;pendingController?.abort();pendingController=null;}
  async function applyPlan(next){
    if(disposed||signal.aborted)throw new Error('Composition disposed');
    if(!canApplyPlan(next))throw new Error('composition-session-replan-required');
    const changes=diff(next);cancelPreparation();
    if(!changes.changed)return {changed:false};
    const updateTicket=updateGeneration,controller=new AbortController();pendingController=controller;
    const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
    let delta=null,committed=false;const additions=new Map(),nextValues=new Map(values),newNodes=new Map();
    try{
      delta=reserveDelta(next,changes);
      const tasks=[];
      for(const requirement of next.requirements)if(!leases.has(requirement.key)){
        const lease=context.pool.acquire(requirement.identity,{signal:controller.signal,generation:updateTicket,
          isCurrent:value=>!disposed&&!signal.aborted&&value===updateGeneration,
          load:({signal,generation})=>requirement.kind==='model'
            ? loadModelResource(requirement,signal,delta.sourceTickets.get(requirement.key))
            : loadResource(THREE,context,requirement,signal,generation,invalidate,delta.sourceTickets.get(requirement.key)),
          releaseValue:value=>value.release()});
        if(!lease)throw new Error('composition-resource-pool-exhausted');
        delta.unclaimedSources.delete(requirement.key);additions.set(requirement.key,lease);
        const task=lease.ready.then(value=>nextValues.set(requirement.key,value));task.catch(()=>{});tasks.push(task);
      }
      await Promise.all(tasks);
      if(controller.signal.aborted||updateTicket!==updateGeneration||disposed)throw new DOMException('Composition update cancelled','AbortError');
      const textTasks = [];
      for (const index of changes.rebuilds) {
        const spec = next.nodePlans[index]; if (spec.node.nodeType !== 'text') continue;
        const requirement = spec.textRaster, nodeScope = delta.newScopes.get(index);
        const lease = context.pool.acquire(requirement.identity, {signal:nodeScope.signal, generation:updateTicket,
          isCurrent:value=>!disposed&&!signal.aborted&&value===updateGeneration,
          load:({signal,generation})=>loadTextRaster(THREE,context,requirement,signal,generation,delta.sourceTickets.get(requirement.key)?.raster),
          releaseValue:value=>value.release()});
        if (!lease) throw new Error('composition-resource-pool-exhausted');
        delta.unclaimedSources.delete(requirement.key); nodeScope.lease(lease); spec.textRasterLease = lease;
        textTasks.push(lease.ready);
      }
      await Promise.all(textTasks);
      if(controller.signal.aborted||updateTicket!==updateGeneration||disposed)throw new DOMException('Composition update cancelled','AbortError');
      for(const index of changes.rebuilds){const spec=next.nodePlans[index];newNodes.set(index,buildNode(THREE,context,delta.newScopes.get(index),spec,nodeAssets(spec,nextValues),generation));}
      const clipUpdates=[];
      for(const index of changes.clips){
        if(changes.rebuilds.has(index))continue;
        const spec=next.nodePlans[index],resource=values.get(spec.resources.asset.key)?.model,name=spec.animation;
        let clip=null;
        if(name){clip=resource?.clips?.find(item=>item.name===name);if(!clip)throw new Error('composition-model-animation-missing');}
        clipUpdates.push({index,clip});
      }
      // Everything that can fail in preparation has finished. The fixed graph
      // keeps its painter order; only changed leaves/resources now retire.
      for(const [index,replacement] of newNodes){const old=nodes[index],parent=old.object.parent;
        replacement.object.renderOrder=old.object.renderOrder;parent.add(replacement.object);parent.remove(old.object);
        nodes[index]=replacement;allocation.nodeScopes[index].dispose();allocation.nodeScopes[index]=delta.newScopes.get(index);
        changes.masks[index]|=ALL;changes.locals[index]=changes.worlds[index]=1;work.nodeRebuilds[index]++;
      }
      delta.newScopes.clear();
      for(const [key,lease] of additions){scope.lease(lease);leases.set(key,lease);values.set(key,nextValues.get(key));}
      const needed=new Set(next.requirements.map(requirement=>requirement.key));
      plan=next;
      refreshTimeline();
      applyOutputEffects();
      visualTime=null;
      for(let index=0;index<nodes.length;index++){
        if (nodes[index].spec.node.nodeType === 'text' && !changes.rebuilds.has(index))
          plan.nodePlans[index].textRasterLease = nodes[index].spec.textRasterLease;
        nodes[index].spec=plan.nodePlans[index];
      }
      for(const {index,clip} of clipUpdates){
        const node=nodes[index];
        node.animationHolder.stop?.();
        node.animation=null;
        if(clip){
          const mixer=new THREE.AnimationMixer(node.animationRoot);
          mixer.clipAction(clip).play();
          node.animation={mixer,clip,duration:clip.duration};
          node.animationHolder.stop=()=>{mixer.stopAllAction();mixer.uncacheRoot(node.animationRoot);};
        }
        changes.masks[index]|=ALL;changes.locals[index]=changes.worlds[index]=1;outputDirty=true;
      }
      dirty.set(changes.masks);localDirty.set(changes.locals);worldDirty.set(changes.worlds);
      for(const index of plan.ir.painterOrder)if(dirty[index])applyNode(nodes[index],dirty[index],!!localDirty[index]);
      for(const [key,lease] of [...leases])if(!needed.has(key)){scope.releaseLease(lease);leases.delete(key);values.delete(key);}
      videos=[...values.values()].filter(value=>value.video);
      allocation.programTickets.push(...delta.programTickets);delta.programTickets.length=0;
      work.slotChanges+=changes.slots;work.constantChanges+=changes.constants;work.resourceChanges+=changes.resources;
      if(changes.output){outputDirty=true;work.outputInvalidations++;}
      frameReady=false;committed=true;options.onInvalidate?.();
      return {changed:true,dirtyNodes:Array.from(dirty),slotChanges:changes.slots,constantChanges:changes.constants,resourceChanges:changes.resources};
    }finally{
      signal.removeEventListener('abort',abort);
      if(!committed){controller.abort();for(const lease of additions.values())lease.release();}
      delta?.cleanup();if(pendingController===controller)pendingController=null;
    }
  }
  function resize(width, height) {
    renderer.getDrawingBufferSize(viewport);
    if (!target || target.width !== viewport.x || target.height !== viewport.y) {
      const pixels = viewport.x * viewport.y;
      if (viewport.x !== plan.projection.target.width || viewport.y !== plan.projection.target.height)
        throw new Error('composition-target-replan-required');
      if (!renderer.extensions.has('EXT_color_buffer_float')) throw new Error('composition-linear-target-unavailable');
      const ticket = allocation.targetTicket;
      let next;
      try {
        next = new THREE.WebGLRenderTarget(viewport.x, viewport.y, { type: THREE.HalfFloatType, format: THREE.RGBAFormat,
          depthBuffer: !!(plan.builtin || plan.has3d), stencilBuffer: false, generateMipmaps: false });
        next.texture.colorSpace = THREE.LinearSRGBColorSpace;
        renderer.initRenderTarget(next); ticket?.commit();
      } catch (error) { next?.dispose(); ticket?.release({ apiReleased: true, allocationEnded: true }); throw error; }
      target?.dispose(); targetTicket?.release({ apiReleased: true, allocationEnded: true }); target = next; targetTicket = ticket;
      allocation.unclaimedPrivate.delete(ticket);
      outputMaterial.uniforms.inputMap.value = target.texture;
    }
    if (plan.outputGlow && (!glowA || glowA.width !== plan.outputGlow.width || glowA.height !== plan.outputGlow.height)) {
      const ticket = allocation.glowTicket;
      let nextA, nextB;
      try {
        const options = { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
          stencilBuffer: false, generateMipmaps: false };
        nextA = new THREE.WebGLRenderTarget(plan.outputGlow.width, plan.outputGlow.height, options);
        nextB = new THREE.WebGLRenderTarget(plan.outputGlow.width, plan.outputGlow.height, options);
        for (const surface of [nextA, nextB]) {
          surface.texture.colorSpace = THREE.LinearSRGBColorSpace;
          surface.texture.minFilter = THREE.LinearFilter; surface.texture.magFilter = THREE.LinearFilter;
          surface.texture.generateMipmaps = false;
          renderer.initRenderTarget(surface);
        }
        ticket?.commit();
      } catch (error) {
        nextA?.dispose(); nextB?.dispose();
        ticket?.release({ apiReleased: true, allocationEnded: true }); throw error;
      }
      glowA?.dispose(); glowB?.dispose(); glowA = nextA; glowB = nextB;
      allocation.unclaimedPrivate.delete(ticket);
      outputMaterial.uniforms.glowMap.value = glowA.texture;
    }
    const canvas = plan.projection.canvas, fit = plan.projection.target.fit || 'cover';
    const sx = width / canvas.width, sy = height / canvas.height;
    const scaleX = fit === 'stretch' ? sx : fit === 'contain' ? Math.min(sx,sy) : Math.max(sx,sy);
    const scaleY = fit === 'stretch' ? sy : scaleX;
    root.matrixAutoUpdate = false; root.matrix.makeScale(scaleX,scaleY,1);
    const left=(width-canvas.width*scaleX)/2,top=(height-canvas.height*scaleY)/2;
    root.matrix.setPosition(left,top,0); root.matrixWorldNeedsUpdate = true;
    // Scissor is in the linear target's physical pixels. Clear the whole target
    // first; fitted author-canvas bounds then clip every rotated/masked leaf.
    const x=Math.max(0,Math.ceil(left*viewport.x/width-.5)),y=Math.max(0,Math.ceil(top*viewport.y/height-.5));
    const right=Math.min(viewport.x,Math.ceil((left+canvas.width*scaleX)*viewport.x/width-.5));
    const bottom=Math.min(viewport.y,Math.ceil((top+canvas.height*scaleY)*viewport.y/height-.5));
    canvasClip.set(x,viewport.y-bottom,Math.max(0,right-x),Math.max(0,bottom-y));
    target.scissor.copy(canvasClip);
    background?.resize(width,height,left,top,canvas.width*scaleX,canvas.height*scaleY);
    camera.left=0; camera.right=width; camera.top=0; camera.bottom=height; camera.updateProjectionMatrix();
    if (modelCamera) { modelCamera.aspect = canvas.width / canvas.height; modelCamera.updateProjectionMatrix(); }
    scene.updateMatrixWorld(true);outputDirty=true;
  }
  function update(frame = {}) {
    if (disposed || signal.aborted) return false;
    if(inputSampler)frame={...frame,...inputSampler.sample(frame)};
    if(frame.redraw===true)outputDirty=true;
    if (Number.isFinite(frame.sceneTime)) sceneTime = Math.max(0, frame.sceneTime);
    else if (!frame.paused) throw new Error('composition-scene-time-required');
    const timeline = plan.projection.timeline;
    const time = timeline.loop ? sceneTime % timeline.durationSeconds : Math.min(sceneTime,timeline.durationSeconds);
    const timeChanged=visualTime!==time;visualTime=time;
    if (timelineBase) applyTimeline(time, frame);
    frameReady = true;
    for (const value of videos) {
      const video = value.video, clock = value.requirement.clock;
      if (video.error) throw new Error('composition-video-decode-failed');
      const expected = (clock.loopStartMs + time*1000 % (clock.loopEndMs-clock.loopStartMs))/1000;
      // Paused/explicit seek requests follow the absolute requested phase. A
      // sparse decoder may report the decoded frame's timestamp after seeked;
      // repeating that same completed request would prevent readiness forever.
      const explicit = frame.paused || frame.seek;
      const targetChanged = Math.abs(value.seekState.target-expected) > .001;
      // Preserve a completed request at its fixed phase until the whole output
      // submits. Another clock can still be seeking after this member is ready.
      const completed = value.seekState.pending && value.seekState.ready && !video.seeking && !targetChanged;
      const needsSeek = explicit ? targetChanged : !completed && !video.seeking && Math.abs(video.currentTime-expected)>.06;
      if (needsSeek) {
        video.pause(); value.seekState.target=expected; value.seekState.ready=false; value.seekState.pending=true;
        video.currentTime=expected; frameReady=false;
      }
      if (video.seeking || !value.seekState.ready || video.readyState < 2) frameReady=false;
      if (value.playError) throw new Error('composition-video-play-failed');
      if(timeChanged||!frame.paused||outputDirty){value.texture.needsUpdate=true;outputDirty=true;}
    }
    mediaShouldPlay=frameReady&&!frame.paused&&!document.hidden&&!frame.seek;
    if(!mediaShouldPlay)pause();
    if(timeChanged)for(const node of nodes)if(node.particles){node.material.uniforms.sceneTime.value=time;outputDirty=true;}
    if(timeChanged)for(const node of nodes)if(node.material&&node.spec.effects){node.material.uniforms.effectTime.value=time;outputDirty=true;}
    if(timeChanged)for(const node of nodes)if(node.animation){
      const animation=node.animation;
      animation.mixer.setTime(animation.duration>0?time%animation.duration:0);
      node.object.updateMatrixWorld(true);
      outputDirty=true;
    }
    if(background) {background.instance.update(frame);outputDirty=true;}
    return frameReady;
  }
  function commitMedia() {
    if (!frameReady || disposed || signal.aborted) return false;
    for(const value of videos)value.seekState.pending=false;
    if(mediaShouldPlay&&!document.hidden)for(const value of videos)if(value.video.paused)
      value.video.play().catch(error=>{if(!disposed){value.playError=error;options.onInvalidate?.();}});
    inputSampler?.commit();
    return true;
  }
  function render() {
    if (!frameReady || disposed) return false;
    if (!outputDirty) return true;
    for(const index of plan.ir.painterOrder)if(worldDirty[index]){
      const parent=nodes[index].spec.node.parentIndex;
      if(parent<0||!worldDirty[parent])nodes[index].object.updateMatrixWorld(true);
      work.worldMatrixUpdates[index]++;
    }
    const autoClear=renderer.autoClear, previousTarget=renderer.getRenderTarget(), previousOutput=renderer.outputColorSpace;
    const previousClear=renderer.getClearColor(savedClear), previousAlpha=renderer.getClearAlpha();
    const previousScissor=renderer.getScissor(savedScissor),previousScissorTest=renderer.getScissorTest();
    const previousPrograms=renderer.hertzProgramResources;
    try {
      if (context.pagePort) renderer.hertzProgramResources={require(resources) {
        if (resources.programs!==1 || allocation.programTickets.length===0) throw new Error('composition-shader-plan-exhausted');
        return allocation.programTickets.shift();
      }};
      renderer.autoClear=false; renderer.outputColorSpace=THREE.LinearSRGBColorSpace;
      target.scissorTest=false;renderer.setRenderTarget(target);renderer.setClearColor(clearColor,1);renderer.clear();
      target.scissorTest=true;renderer.setRenderTarget(target);
      if(background){renderer.render(background.scene,background.camera);renderer.clearDepth();}
      if(modelCamera){modelScene.updateMatrixWorld(true);renderer.render(modelScene,modelCamera);renderer.clearDepth();}
      renderer.render(scene,camera);
      if(glowA){
        const glow=plan.outputGlow;
        renderer.setScissorTest(false);renderer.setClearColor(0x000000,1);
        thresholdMaterial.uniforms.inputMap.value=target.texture;glowMesh.material=thresholdMaterial;
        renderer.setRenderTarget(glowA);renderer.clear();renderer.render(glowScene,outputCamera);
        blurMaterial.uniforms.inputMap.value=glowA.texture;
        blurMaterial.uniforms.blurStep.value.set(glow.radius/8/glowA.width,0);glowMesh.material=blurMaterial;
        renderer.setRenderTarget(glowB);renderer.clear();renderer.render(glowScene,outputCamera);
        blurMaterial.uniforms.inputMap.value=glowB.texture;
        blurMaterial.uniforms.blurStep.value.set(0,glow.radius/8/glowA.height);
        renderer.setRenderTarget(glowA);renderer.clear();renderer.render(glowScene,outputCamera);
      }
      renderer.setRenderTarget(null);renderer.setScissorTest(false);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.render(outputScene,outputCamera);
      dirty.fill(0);localDirty.fill(0);worldDirty.fill(0);outputDirty=false;work.renders++;
    } finally {renderer.hertzProgramResources=previousPrograms;renderer.setRenderTarget(previousTarget);renderer.setScissor(previousScissor);renderer.setScissorTest(previousScissorTest);renderer.outputColorSpace=previousOutput;renderer.setClearColor(previousClear,previousAlpha);renderer.autoClear=autoClear;}
    return true;
  }
  function dispose() {
    if (disposed) return; disposed=true;cancelPreparation(); pause(); target?.dispose(); target=null;
    glowA?.dispose(); glowB?.dispose(); glowA=glowB=null;
    targetTicket?.release({ apiReleased: true, allocationEnded: true }); targetTicket=null;
    allocation.glowTicket?.release({ apiReleased: true, allocationEnded: true });
    scene.clear(); outputScene.clear(); modelScene?.clear();
    inputSampler=null;background=null;
  }
  scope.defer(dispose);
  return { scene, camera, update, render, commitMedia, resize, suspend: pause, dispose,canApplyPlan,applyPlan,cancelPreparation,
    get pendingPreparation(){return !!pendingController;},
    scopeStats(){return allocation.nodeScopes.reduce((sum,nodeScope)=>{
      const value=nodeScope.stats();for(const key of ['resources','tasks','estimatedBytes','cleanups','leases','admissionTickets','allocationTasks'])sum[key]+=value[key]||0;
      sum.cleanupFailed ||= value.cleanupFailed;return sum;
    },{resources:0,tasks:0,estimatedBytes:0,cleanups:0,leases:0,admissionTickets:0,allocationTasks:0,cleanupFailed:false});},
    retirementCandidates(){
      if(pendingController||disposed)return [];
      const ids=allocation.nodeScopes.flatMap(nodeScope=>nodeScope.retirementCandidates(renderer)),programUses=new Map();
      for(const node of nodes)for(const material of node.materials||(node.material?[node.material]:[]))
        renderer.properties.get(material).programs?.forEach(program=>programUses.set(program,(programUses.get(program)||0)+1));
      // Multiple retiring node scopes can be the complete set of users of one
      // original Three cache entry. Only that complete set forecasts its quota.
      for(const [program,count] of programUses)if(count===program.usedTimes&&program.hertzProgramResourceId)ids.push(program.hertzProgramResourceId);
      if(targetTicket)ids.push(targetTicket.resourceId);
      if(allocation.glowTicket)ids.push(allocation.glowTicket.resourceId);
      for(const ticket of allocation.programTickets)if(ticket)ids.push(ticket.resourceId);
      ids.push(...context.pool.retirementCandidates([...leases.values(),
        ...nodes.filter(node=>node.spec.node.nodeType==='text').map(node=>node.spec.textRasterLease)]));
      return [...new Set(ids)];
    },
    canResize: (pixelWidth,pixelHeight) => pixelWidth===plan.projection.target.width && pixelHeight===plan.projection.target.height,
    validateSurface:(cssWidth,cssHeight,deviceScale)=>!plan.builtin || deviceScale===plan.builtin.facts.targetFacts.deviceScale
      && Math.abs(cssWidth*deviceScale-plan.builtin.facts.targetFacts.physicalWidth)<=deviceScale
      && Math.abs(cssHeight*deviceScale-plan.builtin.facts.targetFacts.physicalHeight)<=deviceScale,
    stats: () => ({ composition: true, semanticKey: plan.ir.semanticKey, nodes: nodes.length, resourceLeases: leases.size,
      models: nodes.filter(node => node.model).length, has3d: !!modelCamera,
      sessionId:plan.projection.sessionId, generation:plan.projection.generation,
      budgetAllocationRevision:plan.projection.target.budgetAllocationRevision,
      videoClocks:videos.map(value=>({currentTime:value.video.currentTime,readyState:value.video.readyState,
        seeking:value.video.seeking,paused:value.video.paused,requestedTime:value.seekState.target,seekReady:value.seekState.ready,seekPending:value.seekState.pending})),
      dirtyMasks:Array.from(dirty),work:{...work,matrixUpdates:Array.from(work.matrixUpdates),worldMatrixUpdates:Array.from(work.worldMatrixUpdates),
        materialUpdates:Array.from(work.materialUpdates),nodeRebuilds:Array.from(work.nodeRebuilds)},
      preparationPending:!!pendingController,
      builtin:plan.builtin?{sceneId:plan.builtin.facts.sceneId,nodeIndex:plan.builtin.index,
        actualQuality:plan.builtin.facts.actualQuality,profileHash:plan.builtin.facts.profileHash,
        targetFacts:plan.builtin.facts.targetFacts,input:inputSampler?.stats(),depthBytes:plan.pixels*4}:null,
      sceneTime, ready: frameReady, contextId: context.contextId, linearOutputPasses: 1 }) };
}

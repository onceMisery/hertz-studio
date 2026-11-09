// SPDX-License-Identifier: MIT
import { buildNode, loadResource, loadTextRaster, updateNodeMaterial } from './nodes.js';
import { createScope } from '../scope.js';
const MATRIX=1, LAYOUT=2, MATERIAL=4, VISIBILITY=8, RESOURCE=16, GEOMETRY=32, ALL=63;
const outputVertex = `varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`;
const outputFragment = `uniform sampler2D inputMap;varying vec2 vUv;
  void main(){gl_FragColor=texture2D(inputMap,vUv);
  #include <colorspace_fragment>
  }`;
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
  const nodeScopes=plan.nodePlans.map(()=>createScope({resources:context.pagePort,generation}));
  scope.defer(()=>nodeScopes.forEach(nodeScope=>nodeScope.dispose()));
  const require = (resources, source) => {
    const ticket = context.pagePort?.require(resources, source, generation, 'bounded-estimate');
    if (ticket) reserved.push(ticket); return ticket;
  };
  try {
    const targetTicket = require({ renderTargetDeclaredBytes: plan.pixels * 8 }, 'Composition planned linear RGBA16F target');
    if (targetTicket) unclaimedPrivate.add(targetTicket);
    for (let index=0; index<plan.resources.programs; index++) programTickets.push(require({programs:1}, 'Composition bounded shader program cache miss'));
    const outputPlan = scope.bufferPlan(92,92,'Composition final output quad');
    for (const spec of plan.nodePlans) {
      if (spec.node.nodeType !== 'group') {
        const bytes = spec.node.nodeType === 'particles' ? spec.count * 20 : 92;
        spec.bufferPlan = nodeScopes[spec.index].bufferPlan(bytes,bytes,'Composition fixed node buffers');
      }
    }
    for (const requirement of plan.requirements) {
      if (context.pool.has(requirement.identity)) continue;
      let admissions;
      if (requirement.kind === 'font') admissions={cpu:require({ownedCpuBytes:requirement.fontMetadata.cpuBudgetBytes},'Composition prepared same-package font')};
      else {
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
      for (const requirement of unclaimed) for (const ticket of Object.values(sources.get(requirement))) ticket?.release({apiReleased:true,allocationEnded:true});
      for (const ticket of programTickets) ticket?.release({apiReleased:true,allocationEnded:true});
      for (const ticket of unclaimedPrivate) ticket.release({apiReleased:true,allocationEnded:true});
    });
    return { sources, unclaimed, unclaimedPrivate, targetTicket, outputPlan, programTickets, nodeScopes };
  } catch (error) {
    for (const ticket of reserved) ticket.release({apiReleased:true,allocationEnded:true});
    throw error;
  }
}
export async function createCompositionRuntime(THREE, context, scope, plan, options = {}) {
  const signal = scope.signal, generation = options.generation, leases = new Map(), values = new Map();
  let disposed = false, target = null, targetTicket = null, sceneTime = 0, frameReady = false, outputDirty=true;
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
  const allocation = reserveAll(context,scope,plan,generation);
  function invalidate(){outputDirty=true;options.onInvalidate?.();}
  // Every requirement was admitted as one target plan before the first load.
  const loading = [];
  for (const requirement of plan.requirements) {
    const lease = context.pool.acquire(requirement.identity, { signal, generation, isCurrent: options.isCurrent,
      load: ({ signal, generation }) => loadResource(THREE, context, requirement, signal, generation, invalidate, allocation.sources.get(requirement)),
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
  const nodes = plan.nodePlans.map(spec => buildNode(THREE, context, allocation.nodeScopes[spec.index], spec,nodeAssets(spec),generation));
  for (const index of plan.ir.painterOrder) {
    const node = nodes[index], parent = node.spec.node.parentIndex;
    (parent < 0 ? root : nodes[parent].object).add(node.object);
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
    depthTest: false, depthWrite: false, toneMapped: false, uniforms: { inputMap: { value: null } } }));
  outputScene.add(new THREE.Mesh(outputGeometry, outputMaterial));
  const clearColor = new THREE.Color(plan.projection.canvas.background), viewport = new THREE.Vector2(), canvasClip=new THREE.Vector4();
  const savedScissor=new THREE.Vector4(), savedClear=new THREE.Color();
  let videos = [...values.values()].filter(value => value.video);
  function pause() { for (const value of videos) value.video.pause(); }
  scope.listen(document, 'visibilitychange', () => { if (document.hidden) pause(); });
  scope.defer(()=>pendingController?.abort());
  function applyNode(node, mask=ALL, changeLocal=true) {
    const spec = node.spec, n = spec.number, parent = spec.node.parentIndex < 0 ? null : nodes[spec.node.parentIndex];
    if (mask & (MATERIAL|VISIBILITY)) {
      node.opacity = (parent?.opacity ?? 1) * n('opacity');
      node.object.visible = (parent?.object.visible ?? true) && spec.constant('visible');
      if(node.material){node.material.uniforms.opacity.value=node.opacity;updateNodeMaterial(THREE,node,nodeAssets(spec));}
      work.materialUpdates[spec.index]++;
    }
    if (!changeLocal) return;
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
  function canApplyPlan(next){
    const old=plan.projection, candidate=next.projection, a=old.target,b=candidate.target;
    return candidate.semanticKey===old.semanticKey&&candidate.sessionId===old.sessionId&&candidate.generation===old.generation
      && (candidate.clockDomain||candidate.sessionId)===(old.clockDomain||old.sessionId)
      && a.width===b.width&&a.height===b.height&&(a.fit||'cover')===(b.fit||'cover')
      && a.budgetFps===b.budgetFps&&a.budgetAllocationRevision===b.budgetAllocationRevision
      && JSON.stringify(next.ir)===irBytes&&JSON.stringify(candidate.canvas)===canvasBytes&&JSON.stringify(candidate.timeline)===timelineBytes;
  }
  function diff(next){
    const masks=new Uint32Array(nodes.length), locals=new Uint8Array(nodes.length), worlds=new Uint8Array(nodes.length), rebuilds=new Set();
    let slots=0,constants=0,resources=0,output=false;
    function dependency(dep){
      for(const affected of dep.nodes)masks[affected.nodeIndex]|=affected.mask;
      output ||= dep.output;
    }
    function matrix(index){
      locals[index]=1;worlds[index]=1;
      for(const descendant of plan.ir.matrixDependents[index])worlds[descendant]=1;
    }
    for(let index=0;index<plan.values.numeric.length;index++)if(plan.values.numeric[index]!==next.values.numeric[index]){
      slots++;const slot=plan.ir.numericSlots[index],type=plan.ir.nodes[slot.nodeIndex].nodeType,dep=plan.ir.slotDependencies[index];dependency(dep);
      if(dep.nodes.some(node=>node.nodeIndex===slot.nodeIndex&&(node.mask&MATRIX)))matrix(slot.nodeIndex);
      if(type==='text'&&['width','height','fontSize','lineHeight'].includes(slot.property)
        ||type==='particles'&&['count','seed'].includes(slot.property))rebuilds.add(slot.nodeIndex);
    }
    for(let index=0;index<plan.values.constants.length;index++)if(plan.values.constants[index]!==next.values.constants[index]){
      constants++;const slot=plan.ir.constantSlots[index],type=plan.ir.nodes[slot.nodeIndex].nodeType,dep=constantDependencies[index];dependency(dep);
      if(dep.nodes.some(node=>node.nodeIndex===slot.nodeIndex&&(node.mask&MATRIX))||type==='image'&&slot.property==='fit')matrix(slot.nodeIndex);
      if(type==='text'&&['text','color','align'].includes(slot.property))rebuilds.add(slot.nodeIndex);
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
        if(plan.ir.nodes[index].nodeType==='image')matrix(index);
      }
      if (plan.ir.nodes[index].nodeType === 'text'
          && plan.nodePlans[index].textRaster.key !== next.nodePlans[index].textRaster.key) {
        rebuilds.add(index); masks[index] |= LAYOUT | MATERIAL; output = true;
      }
    }
    return {masks,locals,worlds,rebuilds,slots,constants,resources,output,changed:!!(slots||constants||resources||rebuilds.size)};
  }
  function reserveDelta(next,changes){
    validateTextTextureSize(context, next);
    const newScopes=new Map(), sourceTickets=new Map(), unclaimedSources=new Set(), unusedPrivate=new Set(), programTickets=[];
    const reserved=[];const require=(amount,label)=>{const ticket=context.pagePort.require(amount,label,generation,'bounded-estimate');reserved.push(ticket);return ticket;};
    const amount={programs:0,ownedCpuBytes:0,bufferDeclaredBytes:0,textureDeclaredBytes:0,decodeReservedBytes:0,decoderLeases:0,canvases:0,drawingBufferPixels:0};
    const variants=new Set();
    for(const index of changes.rebuilds){const spec=next.nodePlans[index],bytes=spec.node.nodeType==='particles'?spec.count*20:92;
      amount.ownedCpuBytes+=bytes;amount.bufferDeclaredBytes+=bytes;variants.add(spec.node.nodeType==='particles'?'particles':'planar');
    }
    amount.programs=Math.max(0,variants.size-allocation.programTickets.length);
    for(const requirement of next.requirements)if(!leases.has(requirement.key)&&!context.pool.has(requirement.identity)){
      if(requirement.kind==='font')amount.ownedCpuBytes+=requirement.fontMetadata.cpuBudgetBytes;
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
      for(const key of unclaimedSources)for(const ticket of Object.values(sourceTickets.get(key)))ticket.release({apiReleased:true,allocationEnded:true});
      for(const ticket of unusedPrivate)ticket.release({apiReleased:true,allocationEnded:true});
      for(const ticket of programTickets)ticket.release({apiReleased:true,allocationEnded:true});
    }
    try{
      for(let index=0;index<amount.programs;index++)programTickets.push(require({programs:1},'Composition changed-node shader cache miss'));
      for(const index of changes.rebuilds){const spec=next.nodePlans[index],nodeScope=createScope({resources:context.pagePort,generation});newScopes.set(index,nodeScope);
        const bytes=spec.node.nodeType==='particles'?spec.count*20:92;spec.bufferPlan=nodeScope.bufferPlan(bytes,bytes,'Composition changed-node fixed buffers');
      }
      for(const requirement of next.requirements)if(!leases.has(requirement.key)&&!context.pool.has(requirement.identity)){
        let tickets;
        if(requirement.kind==='font')tickets={cpu:require({ownedCpuBytes:requirement.fontMetadata.cpuBudgetBytes},'Composition changed prepared same-package font')};
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
          load:({signal,generation})=>loadResource(THREE,context,requirement,signal,generation,invalidate,delta.sourceTickets.get(requirement.key)),releaseValue:value=>value.release()});
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
      for(let index=0;index<nodes.length;index++){
        if (nodes[index].spec.node.nodeType === 'text' && !changes.rebuilds.has(index))
          plan.nodePlans[index].textRasterLease = nodes[index].spec.textRasterLease;
        nodes[index].spec=plan.nodePlans[index];
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
          depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
        next.texture.colorSpace = THREE.LinearSRGBColorSpace;
        renderer.initRenderTarget(next); ticket?.commit();
      } catch (error) { next?.dispose(); ticket?.release({ apiReleased: true, allocationEnded: true }); throw error; }
      target?.dispose(); targetTicket?.release({ apiReleased: true, allocationEnded: true }); target = next; targetTicket = ticket;
      allocation.unclaimedPrivate.delete(ticket);
      outputMaterial.uniforms.inputMap.value = target.texture;
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
    camera.left=0; camera.right=width; camera.top=0; camera.bottom=height; camera.updateProjectionMatrix();
    scene.updateMatrixWorld(true);outputDirty=true;
  }
  function update(frame = {}) {
    if (disposed || signal.aborted) return false;
    if(frame.redraw===true)outputDirty=true;
    if (Number.isFinite(frame.sceneTime)) sceneTime = Math.max(0, frame.sceneTime);
    else if (!frame.paused) throw new Error('composition-scene-time-required');
    const timeline = plan.projection.timeline;
    const time = timeline.loop ? sceneTime % timeline.durationSeconds : Math.min(sceneTime,timeline.durationSeconds);
    const timeChanged=visualTime!==time;visualTime=time;
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
    return frameReady;
  }
  function commitMedia() {
    if (!frameReady || disposed || signal.aborted) return false;
    for(const value of videos)value.seekState.pending=false;
    if(mediaShouldPlay&&!document.hidden)for(const value of videos)if(value.video.paused)
      value.video.play().catch(error=>{if(!disposed){value.playError=error;options.onInvalidate?.();}});
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
      target.scissorTest=true;renderer.setRenderTarget(target);renderer.render(scene,camera);
      renderer.setRenderTarget(null);renderer.setScissorTest(false);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.render(outputScene,outputCamera);
      dirty.fill(0);localDirty.fill(0);worldDirty.fill(0);outputDirty=false;work.renders++;
    } finally {renderer.hertzProgramResources=previousPrograms;renderer.setRenderTarget(previousTarget);renderer.setScissor(previousScissor);renderer.setScissorTest(previousScissorTest);renderer.outputColorSpace=previousOutput;renderer.setClearColor(previousClear,previousAlpha);renderer.autoClear=autoClear;}
    return true;
  }
  function dispose() {
    if (disposed) return; disposed=true;cancelPreparation(); pause(); target?.dispose(); target=null;
    targetTicket?.release({ apiReleased: true, allocationEnded: true }); targetTicket=null; scene.clear(); outputScene.clear();
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
      for(const node of nodes)if(node.material)renderer.properties.get(node.material).programs?.forEach(program=>programUses.set(program,(programUses.get(program)||0)+1));
      // Multiple retiring node scopes can be the complete set of users of one
      // original Three cache entry. Only that complete set forecasts its quota.
      for(const [program,count] of programUses)if(count===program.usedTimes&&program.hertzProgramResourceId)ids.push(program.hertzProgramResourceId);
      if(targetTicket)ids.push(targetTicket.resourceId);
      for(const ticket of allocation.programTickets)if(ticket)ids.push(ticket.resourceId);
      ids.push(...context.pool.retirementCandidates([...leases.values(),
        ...nodes.filter(node=>node.spec.node.nodeType==='text').map(node=>node.spec.textRasterLease)]));
      return [...new Set(ids)];
    },
    canResize: (pixelWidth,pixelHeight) => pixelWidth===plan.projection.target.width && pixelHeight===plan.projection.target.height,
    stats: () => ({ composition: true, semanticKey: plan.ir.semanticKey, nodes: nodes.length, resourceLeases: leases.size,
      sessionId:plan.projection.sessionId, generation:plan.projection.generation,
      budgetAllocationRevision:plan.projection.target.budgetAllocationRevision,
      videoClocks:videos.map(value=>({currentTime:value.video.currentTime,readyState:value.video.readyState,
        seeking:value.video.seeking,paused:value.video.paused,requestedTime:value.seekState.target,seekReady:value.seekState.ready,seekPending:value.seekState.pending})),
      dirtyMasks:Array.from(dirty),work:{...work,matrixUpdates:Array.from(work.matrixUpdates),worldMatrixUpdates:Array.from(work.worldMatrixUpdates),
        materialUpdates:Array.from(work.materialUpdates),nodeRebuilds:Array.from(work.nodeRebuilds)},
      preparationPending:!!pendingController,
      sceneTime, ready: frameReady, contextId: context.contextId, linearOutputPasses: 1 }) };
}

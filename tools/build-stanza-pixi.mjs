// SPDX-License-Identifier: MIT
// Strict source-owned allocation and retirement seams in the pinned runtime.
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=resolve(root,'tools/stanza-pixi/pixi-8.20.1.min.js');
const output=resolve(root,'plugin/ui/vendor/pixi.min.js');
const hash=value=>createHash('sha256').update(value).digest('hex');
const input=readFileSync(source,'utf8');
if(hash(input)!=='9948591083793305468d73915a3ea85032dcf8e32eee7a1328585050d7a14d53')throw new Error('Pinned Pixi input SHA256 mismatch');
let patched=input;
function seam(before,after){
  if(patched.split(before).length!==2)throw new Error('Pinned Pixi seam mismatch: '+before.slice(0,100));
  patched=patched.replace(before,()=>after);
}
seam('var PIXI=(function(d){"use strict";"use strict";',
  'var PIXI=(function(d){"use strict";"use strict";'+readFileSync(resolve(root,'tools/stanza-pixi/admission-runtime.js'),'utf8')+'hertzPixiResources.bootstrap();');
seam('const s=new i;return await s.init(n),s',
  'const s=hertzPixiResources.run(n.hertzResourceOwner,()=>new i);try{return await s.init(n),s}catch(error){try{s.destroy({removeView:true,releaseGlobalResources:false})}catch(cleanupError){error.pixiCleanupFailure=cleanupError;error.pixiPartialRenderer=s}throw error}');
seam('await Do(e),this._addSystems(this.config.systems),this._addPipes(this.config.renderPipes,this.config.renderPipeAdaptors);',
  'await Do(e),this.hertzResourceOwner=t.hertzResourceOwner,hertzPixiResources.run(this.hertzResourceOwner,()=>{this._addSystems(this.config.systems);this._addPipes(this.config.renderPipes,this.config.renderPipeAdaptors)});');
seam('await this.runners.init.items[i].init(t);','await hertzPixiResources.run(this.hertzResourceOwner,()=>this.runners.init.items[i].init(t));');
seam('createCanvas:(r,t)=>{const e=document.createElement("canvas");return e.width=r,e.height=t,e}',
  'createCanvas:(r,t)=>hertzPixiResources.canvas(r,t)');
// This module-load Canvas2D capability probe has no retaining consumer. Its
// three 6x1 canvases and one RGBA8 readback retire in its original sync scope.
seam('function co(){if(Pr!==void 0)return Pr;try{const r=Up("#ff00ff"),t=Up("#ffff00"),e=H.get().createCanvas(6,1).getContext("2d");e.globalCompositeOperation="multiply",e.drawImage(r,0,0),e.drawImage(t,2,0);const i=e.getImageData(2,0,1,1);if(!i)Pr=!1;else{const n=i.data;Pr=n[0]===255&&n[1]===0&&n[2]===0}}catch(r){Pr=!1}return Pr}',
  'function co(){if(Pr!==void 0)return Pr;let r,t,e;try{r=Up("#ff00ff");t=Up("#ffff00");e=H.get().createCanvas(6,1).getContext("2d");e.globalCompositeOperation="multiply";e.drawImage(r,0,0);e.drawImage(t,2,0);Pr=hertzPixiResources.transient(4,"multiply capability RGBA8 readback",()=>{const i=e.getImageData(2,0,1,1);return !!i&&i.data[0]===255&&i.data[1]===0&&i.data[2]===0})}catch(error){if(error.resourceFailure)throw error;Pr=false}finally{hertzPixiResources.retireCanvas(r);hertzPixiResources.retireCanvas(t);hertzPixiResources.retireCanvas(e&&e.canvas)}return Pr}');
seam('_createCanvasAndContext(t,e){const i=H.get().createCanvas();i.width=t,i.height=e;',
  '_createCanvasAndContext(t,e){const i=hertzPixiResources.sharedCanvas(t,e);');
seam('clear(){this._canvasPool={}}','clear(){for(const rows of Object.values(this._canvasPool))for(const row of rows)hertzPixiResources.retireCanvas(row.canvas);this._canvasPool={}}');
seam('const e=new OffscreenCanvas(0,0),i=e.getContext("2d",Eb);','const e=hertzPixiResources.sharedCanvas(0,0),i=e.getContext("2d",Eb);');
seam('_initSource(t){const e=this._gl,i=new Gc(e.createTexture());',
  '_initSource(t){const e=this._gl;e._hertzSource&&e._hertzSource(t);const i=new Gc(e.createTexture());');
// Retire the real capability probes instead of keeping their canvas/context
// slots in the shared page owner after native context loss.
seam('function Pi(r){return Xo!==void 0||(Xo=(()=>{var t;const e={stencil:!0,failIfMajorPerformanceCaveat:r!=null?r:Or.defaultOptions.failIfMajorPerformanceCaveat};try{if(!H.get().getWebGLRenderingContext())return!1;let i=H.get().createCanvas().getContext("webgl",e);const n=!!((t=i==null?void 0:i.getContextAttributes())!=null&&t.stencil);if(i){const s=i.getExtension("WEBGL_lose_context");s&&s.loseContext()}return i=null,n}catch(i){return!1}})()),Xo}',
  'function Pi(r){if(Xo!==void 0)return Xo;let canvas;try{if(!H.get().getWebGLRenderingContext())return Xo=false;canvas=H.get().createCanvas();const gl=canvas.getContext("webgl",{stencil:true,failIfMajorPerformanceCaveat:r??Or.defaultOptions.failIfMajorPerformanceCaveat});return Xo=!!(gl&&gl.getContextAttributes()?.stencil)}catch(error){if(error.resourceFailure)throw error;return Xo=false}finally{hertzPixiResources.retireCanvas(canvas)}}');
// DOM pipe construction precedes its init runner. A rejected ViewSystem must
// still be able to retire that original pipe without an observer that never ran.
seam('this._domElement.remove(),this._canvasObserver.destroy(),this._renderer=null',
  'this._domElement.remove(),this._canvasObserver?.destroy(),this._canvasObserver=null,this._renderer=null');
seam('destroy(){this._shader.destroy(!0),this._shader=null}}kc.extension',
  'destroy(){this._shader?.destroy(!0),this._shader=null}}kc.extension');
seam('destroy(t=!1){(typeof t=="boolean"?t:t!=null&&t.removeView)&&this.canvas.parentNode&&this.canvas.parentNode.removeChild(this.canvas),this.texture.destroy()}',
  'destroy(t=!1){(typeof t=="boolean"?t:t!=null&&t.removeView)&&this.canvas?.parentNode&&this.canvas.parentNode.removeChild(this.canvas),this.renderTarget?.destroy(),this.renderTarget=null,this.texture?.destroy()}');
seam('this._renderer=null,e.removeEventListener("webglcontextlost",this.handleContextLost),e.removeEventListener("webglcontextrestored",this.handleContextRestored),this.gl.useProgram(null)',
  'this._renderer=null,e?.removeEventListener("webglcontextlost",this.handleContextLost),e?.removeEventListener("webglcontextrestored",this.handleContextRestored),this.gl?.useProgram(null)');
seam('function vo(){return(!yi||yi!=null&&yi.isContextLost())&&(yi=H.get().createCanvas().getContext("webgl",{})),yi}',
  'function vo(){if(!yi||yi.isContextLost()){const canvas=H.get().createCanvas();try{yi=canvas.getContext("webgl",{});if(!yi)hertzPixiResources.retireCanvas(canvas)}catch(error){hertzPixiResources.retireCanvas(canvas);throw error}}return yi}');
seam('function dm(){var r;if(Dr)return Dr;const t=vo();return Dr=t.getParameter(t.MAX_TEXTURE_IMAGE_UNITS),Dr=Jo(Dr,t),(r=t.getExtension("WEBGL_lose_context"))==null||r.loseContext(),Dr}',
  'function dm(){if(Dr)return Dr;const t=vo();try{const value=Jo(t.getParameter(t.MAX_TEXTURE_IMAGE_UNITS),t);return Dr=value}finally{hertzPixiResources.retireCanvas(t&&t.canvas)}}');
seam('function Np(){if(!Fn){Fn="mediump";const r=vo();r&&r.getShaderPrecisionFormat&&(Fn=r.getShaderPrecisionFormat(r.FRAGMENT_SHADER,r.HIGH_FLOAT).precision?"highp":"mediump")}return Fn}',
  'function Np(){if(!Fn){const r=vo();try{Fn=r&&r.getShaderPrecisionFormat&&r.getShaderPrecisionFormat(r.FRAGMENT_SHADER,r.HIGH_FLOAT).precision?"highp":"mediump"}finally{hertzPixiResources.retireCanvas(r&&r.canvas)}}return Fn}');
seam('handleContextLost(t){t.preventDefault(),this._contextLossForced',
  'handleContextLost(t){if(this._renderer.hertzResourceOwner){t.preventDefault();this._renderer.hertzResourceFailure="context-lost";return}t.preventDefault(),this._contextLossForced');
seam('handleContextRestored(){this.getExtensions(),',
  'handleContextRestored(){if(this._renderer.hertzResourceOwner)return;this.getExtensions(),');
// Original reusable batch backing stores; aliases do not acquire a second
// charge. Growth reserves the whole new buffer while the old buffer is live.
seam('this.rawBinaryData=new ArrayBuffer(t)',
  'this.rawBinaryData=hertzPixiResources.typed(ArrayBuffer,t,"ViewableBuffer backing capacity")');
seam('destroy(){this.rawBinaryData=null,',
  'destroy(){hertzPixiResources.freeTyped(this.rawBinaryData);this.rawBinaryData=null,');
seam('this.indexBuffer=new Uint16Array(n),this.maxTextures=e',
  'this.indexBuffer=hertzPixiResources.typed(Uint16Array,n,"batch index capacity"),this.maxTextures=e');
// A base constructor can fail after the first backing was allocated, before
// the derived batcher or renderer owns it. Release that original allocation.
seam('this.attributeBuffer=new lr(i*4),this.indexBuffer=hertzPixiResources.typed(Uint16Array,n,"batch index capacity"),this.maxTextures=e}',
  'this.attributeBuffer=new lr(i*4);try{this.indexBuffer=hertzPixiResources.typed(Uint16Array,n,"batch index capacity");this.maxTextures=e}catch(error){this.attributeBuffer.destroy();this.attributeBuffer=null;throw error}}');
seam('super(t),this.geometry=new Tm,this.name=Z1.extension.name,this.vertexSize=6,Fi!=null||(Fi=new ol(t.maxTextures)),this.shader=Fi}',
  'super(t);try{this.geometry=new Tm;this.name=Z1.extension.name;this.vertexSize=6;Fi!=null||(Fi=new ol(t.maxTextures));this.shader=Fi}catch(error){if(this.geometry)this.geometry.destroy(!0);hertzPixiResources.freeTyped(this.indexBuffer);this.indexBuffer=null;this.attributeBuffer.destroy();this.attributeBuffer=null;throw error}}');
seam('this.attributeBuffer=i}_resizeIndexBuffer(t)',
  'hertzPixiResources.freeTyped(this.attributeBuffer.rawBinaryData),this.attributeBuffer=i}_resizeIndexBuffer(t)');
seam('const n=i>65535?new Uint32Array(i):new Uint16Array(i);',
  'const n=hertzPixiResources.typed(i>65535?Uint32Array:Uint16Array,i,"batch index replacement capacity");');
seam('this.indexBuffer=n}packQuadIndex',
  'hertzPixiResources.freeTyped(e),this.indexBuffer=n}packQuadIndex');
seam('this._elements=null,this.indexBuffer=null,this.attributeBuffer.destroy()',
  'this._elements=null,hertzPixiResources.freeTyped(this.indexBuffer),this.indexBuffer=null,this.attributeBuffer.destroy()');
seam('e&&i.reset(),eg(t,i);','e&&i.reset(),hertzPixiResources.graphics(t,i),eg(t,i);');
seam('this.geometryData.indices.length=0,this.geometryData.vertices.length=0,this.geometryData.uvs.length=0,this.graphicsData=null',
  'this.geometryData={indices:[],vertices:[],uvs:[]},hertzPixiResources.freeGraphics(this),this.graphicsData=null');
seam('render(){this.renderer.render({container:this.stage})}',
  'render(){return hertzPixiResources.run(this.hertzResources,()=>this.renderer.render({container:this.stage}))}');
seam('this.array=new Float32Array(9)',
  'this.array=hertzPixiResources.typed(Float32Array,9,"Matrix float32 serialization")');
seam('this.parent=null,this._maskEffect=null,this._filterEffect=null',
  'this.parent=null,hertzPixiResources.freeTyped(this.localTransform.array),hertzPixiResources.freeTyped(this.relativeGroupTransform.array),this.localTransform.array=this.relativeGroupTransform.array=null,this._maskEffect=null,this._filterEffect=null');
seam('data:new Float32Array(e.layout.size/4),usage:ot.UNIFORM|ot.COPY_DST',
  'data:hertzPixiResources.ownedTyped(Float32Array,e.layout.size/4,"UBO declared CPU backing"),usage:ot.UNIFORM|ot.COPY_DST');
seam('data:new Float32Array(n.layout.size/4),usage:ot.UNIFORM|ot.COPY_DST',
  'data:hertzPixiResources.ownedTyped(Float32Array,n.layout.size/4,"UBO declared CPU backing"),usage:ot.UNIFORM|ot.COPY_DST');
seam('this._data=null,this.descriptor=null,this.removeAllListeners()',
  'hertzPixiResources.freeTyped(this._data),this._data=null,this.descriptor=null,this.removeAllListeners()');
seam('const e=new Int32Array(r);for(let i=0;i<r;i++)e[i]=i;',
  'const e=hertzPixiResources.typed(Int32Array,r,"shared sampler uniform slots");for(let i=0;i<r;i++)e[i]=i;');
// Local renderer uniform vectors retain their exact bytes until their owner
// is destroyed. Shared program metadata stays charged until actual replacement.
function region(start,end,edit){
  const a=patched.indexOf(start),b=patched.indexOf(end,a+start.length);
  if(a<0||b<0)throw new Error('Pinned Pixi region mismatch: '+start);
  patched=patched.slice(0,a)+edit(patched.slice(a,b))+patched.slice(b);
}
function typedCalls(source,label,method='ownedTyped') {
  let count=0;
  const value=source.replace(/new (Float32Array|Int32Array|Uint32Array)\((\[[^\]]*\]|[^()]*)\)/g,(_,type,args)=>{
    count++;return `hertzPixiResources.${method}(${type},${args},${JSON.stringify(label)})`;
  });
  if(!count)throw new Error('Pinned Pixi typed region empty: '+label);
  return value;
}
region('class Fo{','function Sf',s=>typedCalls(s,'filter uniform vectors'));
region('class su{','su.extension=',s=>typedCalls(s,'mesh pipe uniform vector'));
region('class ic{','ic.extension=',s=>typedCalls(s,'global uniform color vector'));
region('class $c{','$c.extension=',s=>typedCalls(s,'graphics adaptor uniform vector'));
region('class tn{','tn.extension=',s=>typedCalls(s,'particle pipe uniform vector'));
region('function Cc(r,t){','let oa=null;',s=>typedCalls(s,'program uniform metadata','typed'));
seam('t._uniformData=Lx(n,r)',
  '(hertzPixiResources.freeUniformData(t._uniformData),t._uniformData=Lx(n,r))');
seam('function Lx(r,t){const e={},i=t.getProgramParameter(r,t.ACTIVE_UNIFORMS);for(let n=0;n<i;n++){',
  'function Lx(r,t){const e={},i=t.getProgramParameter(r,t.ACTIVE_UNIFORMS);try{for(let n=0;n<i;n++){');
seam('value:Cc(l,s.size)}}return e}function Nx',
  'value:Cc(l,s.size)}}return e}catch(error){hertzPixiResources.freeUniformData(e);throw error}}function Nx');
seam('const a={};for(const o in t._uniformData){const l=t._uniformData[o];a[o]={location:r.getUniformLocation(n,o),value:Cc(l.type,l.size)}}return new Bx(n,a)',
  'const a={};try{for(const o in t._uniformData){const l=t._uniformData[o];a[o]={location:r.getUniformLocation(n,o),value:Cc(l.type,l.size)}}return new Bx(n,a)}catch(error){hertzPixiResources.freeUniformData(a);r.deleteProgram(n);throw error}');
seam('destroy(){this.uniformData=null,this.uniformGroups=null',
  'destroy(){hertzPixiResources.freeUniformData(this.uniformData);this.uniformData=null,this.uniformGroups=null');
seam('destroy(){this.fragment=null,this.vertex=null,this._attributeData=null,this._uniformData=null',
  'destroy(){hertzPixiResources.freeUniformData(this._uniformData);this.fragment=null,this.vertex=null,this._attributeData=null,this._uniformData=null');
seam('this._components=new Float32Array(4)',
  'this._components=hertzPixiResources.ownedTyped(Float32Array,4,"Color RGBA float32 components")');
seam('get colorRgba(){return this._backgroundColor.toArray()}destroy(){}',
  'get colorRgba(){return this._backgroundColor.toArray()}destroy(){hertzPixiResources.freeTyped(this._backgroundColor._components);this._backgroundColor._components=null}');
seam('this._passthroughFilter=null}_getPassthroughFilter()',
  'this._passthroughFilter=null;hertzPixiResources.freeUniforms(this._filterGlobalUniforms);this._filterGlobalUniforms=null;this._globalFilterBindGroup.destroy()}_getPassthroughFilter()');
seam('destroy(){this.localUniforms=null,this.localUniformsBindGroup=null',
  'destroy(){hertzPixiResources.freeUniforms(this.localUniforms);this.localUniforms=null,this.localUniformsBindGroup=null');
seam('destroy(){this.shader.destroy(!0),this.shader=null}}$c.extension',
  'destroy(){if(this.shader){hertzPixiResources.freeUniforms(this.shader.resources.localUniforms);this.shader.destroy(!0);this.shader=null}}}$c.extension');
seam('destroy(){this._renderer=null,this._globalUniformDataStack.length=0',
  'destroy(){this._uniformsPool.forEach(hertzPixiResources.freeUniforms);this._activeUniforms.forEach(hertzPixiResources.freeUniforms);this._renderer=null,this._globalUniformDataStack.length=0');
seam('this._size=new Float32Array(2)',
  'this._size=hertzPixiResources.typed(Float32Array,2,"RenderTarget size vector")');
seam('destroy(){!this.colorAttachments&&!this.depthStencilAttachment||',
  'destroy(){hertzPixiResources.freeTyped(this._size);this._size=null;!this.colorAttachments&&!this.depthStencilAttachment||');
seam('this.colorAttachments=i.colorAttachments,this.depthStencilAttachment=i.depthStencilAttachment,this.depthStencilAttachment)',
  'this.colorAttachments=i.colorAttachments,this.depthStencilAttachment=i.depthStencilAttachment,hertzPixiResources.markAttachments(this),this.depthStencilAttachment)');
seam('destroy(){this._managedContainers.destroy(),this.renderer=null,this.defaultShader&&',
  'destroy(){this._managedContainers.destroy(),hertzPixiResources.freeUniforms(this.localUniforms),this.localUniforms=null,this.renderer=null,this.defaultShader&&');
seam('this._dirty&&(this._dirty=!1,this._shapePath.buildPath())',
  'this._dirty&&(hertzPixiResources.pathShape(this,()=>{this._shapePath.buildPath()}),this._dirty=!1)');
seam('onUpdate(){this._boundsDirty=!0,this.dirty=!0,this.emit("update",this,16)}',
  'onUpdate(){hertzPixiResources.usePaths(this);this._boundsDirty=!0,this.dirty=!0,this.emit("update",this,16)}');
seam('this._bounds=new Ct,this._boundsDirty=!0}clone(){const t=new Ge;',
  'this._bounds=new Ct,this._boundsDirty=!0,hertzPixiResources.manageGraphics(this)}clone(){const t=new Ge;');
seam('beginPath(){return this._activePath=new _e,this}',
  'beginPath(){return hertzPixiResources.clearPathData(this._activePath),this._activePath=new _e,this}');
seam('clear(){return this._activePath.clear(),this.instructions.length=0,this.resetTransform()',
  'clear(){return hertzPixiResources.clearPaths(this),this._activePath.clear(),this.instructions.length=0,this.resetTransform()');
seam('this._fillStyle=null,this._strokeStyle=null,this.instructions=null,this._activePath=null',
  'hertzPixiResources.clearPaths(this),this._fillStyle=null,this._strokeStyle=null,this.instructions=null,this._activePath=null');
seam('t._boundsDirty=!0,t}get fillStyle()',
  't._boundsDirty=!0,hertzPixiResources.usePaths(t),t}get fillStyle()');
seam('if(q._measurementCache.has(o))return q._measurementCache.get(o);if(Os(e)',
  'if(q._measurementCache.has(o))return q._measurementCache.get(o);return hertzPixiResources.metrics(q._measurementCache,t,e,o,n,()=>{if(Os(e)');
seam('return q._measurementCache.set(o,v),v}static _adjustWidthForStyle',
  'return v})}static _adjustWidthForStyle');
seam('if(q._fonts[t])return q._fonts[t];const n=q._context;',
  'if(q._fonts[t])return q._fonts[t];return hertzPixiResources.fontMetrics(t,()=>{const n=q._context;');
seam('return q._fonts[t]=l,l}static clearMetrics(t=""){t?delete q._fonts[t]:q._fonts={}}',
  'return q._fonts[t]=l,l})}static clearMetrics(t=""){hertzPixiResources.freeFonts(q._fonts,t);t?delete q._fonts[t]:q._fonts={}}');
seam('return e}clear(){return this.instructions.length=0,this._dirty=!0,this}transform(t)',
  'return hertzPixiResources.clonePathData(this,e),e}clear(){return hertzPixiResources.clearPathData(this),this.instructions.length=0,this._dirty=!0,this}transform(t)');
seam('hertzPixiResources.clearPaths(this),this._fillStyle=null',
  'hertzPixiResources.clearPaths(this),hertzPixiResources.clearPathData(this._activePath),this._fillStyle=null');
// Wrap only the original path command owner. This does not patch Array or DOM
// prototypes, and unchanged frames never pass through these append operations.
seam('function jr(r,t){return r?r.prepend(t):t.clone()}',
  `for(const key of ["arc","arcToSvg","ellipse","lineTo","moveTo","quadraticCurveTo","rect","circle","roundRect","poly","bezierCurveTo"]){const original=_e.prototype[key];_e.prototype[key]=function(){const args=arguments;return hertzPixiResources.pathCommand(this,args,()=>original.apply(this,args))}}
function jr(r,t){return r?r.prepend(t):t.clone()}`);
seam('d.Application=Lf,','d.HertzResourceAdmission=hertzPixiResources,d.Application=Lf,');
const generated='// SPDX-License-Identifier: MIT\n// Generated by node tools/build-stanza-pixi.mjs. Pinned PixiJS 8.20.1, owned resource admission.\n'+patched;
const files=['tools/build-stanza-pixi.mjs','tools/stanza-pixi/admission-runtime.js','tools/stanza-pixi/pixi-8.20.1.min.js','plugin/ui/vendor/pixi.min.js'];
if(process.argv.includes('--check')){
  if(readFileSync(output,'utf8')!==generated)throw new Error('Pixi output does not match the current pinned source/build');
  const manifest=JSON.parse(readFileSync(resolve(root,'tools/stanza-pixi/.build-manifest.json'),'utf8'));
  for(const file of files)if(manifest[file]!==hash(readFileSync(resolve(root,file))))throw new Error('Pixi build identity mismatch: '+file);
}else{
  writeFileSync(output,generated);
  writeFileSync(resolve(root,'tools/stanza-pixi/.build-manifest.json'),JSON.stringify(Object.fromEntries(files.map(file=>[file,hash(readFileSync(resolve(root,file)))])),null,2)+'\n');
}
console.log(`Pinned Pixi 8.20.1 ${process.argv.includes('--check')?'identity verified':'rebuilt'}: ${relative(root,output)}, ${Buffer.byteLength(generated)} bytes.`);

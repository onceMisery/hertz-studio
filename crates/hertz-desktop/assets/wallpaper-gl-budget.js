// SPDX-License-Identifier: MIT
// Trusted builtin GL allocation boundary. The immutable limits are issued by native admission.
(function () {
  'use strict';
  var native = !!window.__hertzWallpaperBinding;
  var allocation = window.__hertzWallpaperGlAllocation || null;
  var contexts = new Set(), waiters = [], failed = null;
  var originalGetContext = HTMLCanvasElement.prototype.getContext;
  var peakBytes = 0, uploads = 0;
  function fail(message) {
    if (!failed) {
      failed = 'gl_budget: ' + message;
      if (window.ipc) window.ipc.postMessage('wallpaper_gl_failed ' + failed);
    }
    throw new Error(failed);
  }
  function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
  function bytesProduct() {
    var value = 1;
    for (var n of arguments) { if (!integer(n) || !Number.isSafeInteger(value *= n)) fail('invalid allocation dimensions'); }
    return value;
  }
  function totals() {
    var bytes = 0, objects = 0, pending = 0;
    contexts.forEach(function (state) { bytes += state.bytes; objects += state.objects.size; pending += state.pendingBytes; });
    return { bytes: bytes, objects: objects, pendingBytes: pending };
  }
  function check(state, nextBytes, nextObjects) {
    if (failed) throw new Error(failed);
    if (state.closed) fail('context has already exited');
    var all = totals();
    if (all.bytes - state.bytes + nextBytes > allocation.gpuBytes) fail('GPU resource reservation exceeded');
    if (all.objects - state.objects.size + nextObjects > 8192) fail('GL object limit exceeded');
    peakBytes = Math.max(peakBytes, all.bytes - state.bytes + nextBytes);
  }
  function formatBytes(gl, internal, format, type) {
    var sized = {
      R8:1,R8_SNORM:1,R8UI:1,R8I:1,R16UI:2,R16I:2,R16F:2,R32UI:4,R32I:4,R32F:4,
      RG8:2,RG8_SNORM:2,RG8UI:2,RG8I:2,RG16UI:4,RG16I:4,RG16F:4,RG32UI:8,RG32I:8,RG32F:8,
      RGB8:3,SRGB8:3,RGB8_SNORM:3,RGB8UI:3,RGB8I:3,RGB16UI:6,RGB16I:6,RGB16F:6,RGB32UI:12,RGB32I:12,RGB32F:12,
      RGBA8:4,SRGB8_ALPHA8:4,RGBA8_SNORM:4,RGBA8UI:4,RGBA8I:4,RGBA16UI:8,RGBA16I:8,RGBA16F:8,RGBA32UI:16,RGBA32I:16,RGBA32F:16,
      RGB565:2,RGBA4:2,RGB5_A1:2,RGB10_A2:4,RGB10_A2UI:4,R11F_G11F_B10F:4,RGB9_E5:4,
      DEPTH_COMPONENT16:2,DEPTH_COMPONENT24:4,DEPTH_COMPONENT32F:4,DEPTH24_STENCIL8:4,DEPTH32F_STENCIL8:8,STENCIL_INDEX8:1
    };
    for (var name in sized) if (gl[name] !== undefined && internal === gl[name]) return sized[name];
    var channels = format === gl.RED || format === gl.RED_INTEGER || format === gl.ALPHA || format === gl.LUMINANCE || format === gl.DEPTH_COMPONENT ? 1
      : format === gl.RG || format === gl.RG_INTEGER || format === gl.LUMINANCE_ALPHA ? 2
        : format === gl.RGB || format === gl.RGB_INTEGER ? 3 : format === gl.RGBA || format === gl.RGBA_INTEGER ? 4 : 0;
    if ([gl.UNSIGNED_SHORT_5_6_5,gl.UNSIGNED_SHORT_4_4_4_4,gl.UNSIGNED_SHORT_5_5_5_1].includes(type)) return 2;
    if ([gl.UNSIGNED_INT_2_10_10_10_REV,gl.UNSIGNED_INT_10F_11F_11F_REV,gl.UNSIGNED_INT_5_9_9_9_REV,gl.UNSIGNED_INT_24_8].includes(type)) return 4;
    var component = type === gl.UNSIGNED_BYTE || type === gl.BYTE ? 1
      : type === gl.UNSIGNED_SHORT || type === gl.SHORT || type === gl.HALF_FLOAT ? 2
        : type === gl.UNSIGNED_INT || type === gl.INT || type === gl.FLOAT ? 4 : 0;
    if (!channels || !component) fail('unplanned texture or renderbuffer format');
    return channels * component;
  }
  function guard(gl, canvas) {
    var state = { gl:gl,canvas:canvas,objects:new Map(),
      bytes:0,pendingBytes:0,pending:[],batches:[],closed:false };
    contexts.add(state);
    function wrap(name, fn) { var original = gl[name]; if (typeof original === 'function') gl[name] = function () { return fn(original, Array.from(arguments)); }; }
    function object(value) { var entry = state.objects.get(value); if (!entry || entry.deleted) fail('unknown GL resource'); return entry; }
    function replace(value, bytes, run) {
      var entry = object(value), old = entry.bytes;
      state.poll();
      // Storage replacement can overlap the old allocation until queued work ends.
      // Charge first; a failed GL call conservatively retains its charge.
      check(state,state.bytes + bytes,state.objects.size);
      entry.bytes = bytes; state.bytes += bytes; uploads += bytes;
      if(old) { state.pending.push(old); state.pendingBytes += old; }
      return run();
    }
    function textureTarget(target) { return target >= gl.TEXTURE_CUBE_MAP_POSITIVE_X && target <= gl.TEXTURE_CUBE_MAP_NEGATIVE_Z ? gl.TEXTURE_CUBE_MAP : target; }
    function texture(target) {
      var binding=new Map([[gl.TEXTURE_2D,gl.TEXTURE_BINDING_2D],[gl.TEXTURE_CUBE_MAP,gl.TEXTURE_BINDING_CUBE_MAP],[gl.TEXTURE_3D,gl.TEXTURE_BINDING_3D],[gl.TEXTURE_2D_ARRAY,gl.TEXTURE_BINDING_2D_ARRAY]]).get(textureTarget(target));
      if(binding===undefined)fail('unplanned texture target');
      return gl.getParameter(binding);
    }
    function level(target, mip, width, height, depth, bpp, run) {
      mip=Math.trunc(mip);
      if(!integer(mip)||mip>31)fail('invalid texture level');
      var value = texture(target), entry = object(value), levels = new Map(entry.levels);
      levels.set(target+':'+mip,{width:width,height:height,depth:depth,bpp:bpp,bytes:bytesProduct(width,height,depth,bpp)});
      var bytes = Array.from(levels.values()).reduce((sum,item)=>sum+item.bytes,0);
      var result = replace(value,bytes,run); entry.levels = levels; return result;
    }
    ['Buffer','Texture','Renderbuffer','Framebuffer','VertexArray','TransformFeedback','Sampler','Program','Shader','Query'].forEach(function (kind) {
      wrap('create'+kind,function (run,args) {
        check(state,state.bytes,state.objects.size+1);
        var value=run.apply(gl,args);if(value)state.objects.set(value,{bytes:0,levels:new Map()});return value;
      });
      wrap('delete'+kind,function (run,args) {
        var entry=state.objects.get(args[0]); var result=run.apply(gl,args);
        // Another VAO/FBO may still reference a deleted object. A GPU fence alone
        // is not proof of exit; retain its bytes and record until context loss.
        if(entry&&!entry.deleted) { entry.deleted=true;state.pendingBytes+=entry.bytes; }
        return result;
      });
    });
    wrap('bufferData',function(run,args){
      var source=args[1],bytes;
      if(typeof source==='number')bytes=source;
      else if(source&&integer(source.byteLength)) {
        var unit=source.BYTES_PER_ELEMENT||1, offset=args[3]||0, count=args[4];
        bytes=count===undefined||count===0?source.byteLength-offset*unit:bytesProduct(count,unit);
      } else fail('invalid buffer allocation');
      if(!integer(bytes))fail('invalid buffer size');
      var binding=new Map([[gl.ARRAY_BUFFER,gl.ARRAY_BUFFER_BINDING],[gl.ELEMENT_ARRAY_BUFFER,gl.ELEMENT_ARRAY_BUFFER_BINDING],
        [gl.COPY_READ_BUFFER,gl.COPY_READ_BUFFER_BINDING],[gl.COPY_WRITE_BUFFER,gl.COPY_WRITE_BUFFER_BINDING],
        [gl.PIXEL_PACK_BUFFER,gl.PIXEL_PACK_BUFFER_BINDING],[gl.PIXEL_UNPACK_BUFFER,gl.PIXEL_UNPACK_BUFFER_BINDING],
        [gl.UNIFORM_BUFFER,gl.UNIFORM_BUFFER_BINDING],[gl.TRANSFORM_FEEDBACK_BUFFER,gl.TRANSFORM_FEEDBACK_BUFFER_BINDING]]).get(args[0]);
      if(binding===undefined)fail('unplanned buffer target');
      return replace(gl.getParameter(binding),bytes,()=>run.apply(gl,args));
    });
    wrap('texImage2D',function(run,args){
      var width,height,format,type;
      if(args.length>=9) {width=args[3];height=args[4];format=args[6];type=args[7];}
      else {var image=args[5];width=image&&(image.videoWidth||image.naturalWidth||image.width);height=image&&(image.videoHeight||image.naturalHeight||image.height);format=args[3];type=args[4];}
      return level(args[0],args[1],width,height,1,formatBytes(gl,args[2],format,type),()=>run.apply(gl,args));
    });
    wrap('texImage3D',function(run,args){return level(args[0],args[1],args[3],args[4],args[5],formatBytes(gl,args[2],args[7],args[8]),()=>run.apply(gl,args));});
    ['texStorage2D','texStorage3D'].forEach(function(name){wrap(name,function(run,args){
      var value=texture(args[0]),entry=object(value),levels=new Map(),bpp=formatBytes(gl,args[2],null,null),bytes=0;
      var faces=args[0]===gl.TEXTURE_CUBE_MAP?6:1,depth=name==='texStorage3D'?args[5]:1;
      // Three computes log2(size)+1 for non-power-of-two textures. Match WebIDL's
      // integer conversion before planning the levels actually passed to GL.
      var mipCount=Math.trunc(args[1]);
      if(!integer(mipCount)||mipCount<1||mipCount>32)fail('invalid mip count');
      for(var face=0;face<faces;face++)for(var mip=0;mip<mipCount;mip++) {
        var w=Math.max(1,Math.floor(args[3]/2**mip)),h=Math.max(1,Math.floor(args[4]/2**mip));
        var d=args[0]===gl.TEXTURE_3D?Math.max(1,Math.floor(depth/2**mip)):depth;
        var item={width:w,height:h,depth:d,bpp:bpp,bytes:bytesProduct(w,h,d,bpp)};
        levels.set((faces===6?gl.TEXTURE_CUBE_MAP_POSITIVE_X+face:args[0])+':'+mip,item);bytes+=item.bytes;
      }
      var result=replace(value,bytes,()=>run.apply(gl,args));entry.levels=levels;return result;
    });});
    wrap('generateMipmap',function(run,args){
      var value=texture(args[0]),entry=object(value),levels=new Map(entry.levels);
      for(var pair of entry.levels)if(pair[0].endsWith(':0')) {
        var item=pair[1],target=pair[0].slice(0,-2),mip=0,w=item.width,h=item.height,d=item.depth;
        while(w>1||h>1||(args[0]===gl.TEXTURE_3D&&d>1)) {
          mip++;w=Math.max(1,Math.floor(w/2));h=Math.max(1,Math.floor(h/2));if(args[0]===gl.TEXTURE_3D)d=Math.max(1,Math.floor(d/2));
          levels.set(target+':'+mip,{width:w,height:h,depth:d,bpp:item.bpp,bytes:bytesProduct(w,h,d,item.bpp)});
        }
      }
      var bytes=Array.from(levels.values()).reduce((sum,item)=>sum+item.bytes,0);
      var result=replace(value,bytes,()=>run.apply(gl,args));entry.levels=levels;return result;
    });
    wrap('copyTexImage2D',function(run,args){return level(args[0],args[1],args[5],args[6],1,formatBytes(gl,args[2],args[2],gl.UNSIGNED_BYTE),()=>run.apply(gl,args));});
    ['compressedTexImage2D','compressedTexImage3D','compressedTexSubImage2D','compressedTexSubImage3D'].forEach(function(name){wrap(name,function(){fail('compressed textures require a planned format adapter');});});
    wrap('renderbufferStorage',function(run,args){return replace(gl.getParameter(gl.RENDERBUFFER_BINDING),bytesProduct(args[2],args[3],formatBytes(gl,args[1],null,null)),()=>run.apply(gl,args));});
    wrap('renderbufferStorageMultisample',function(run,args){return replace(gl.getParameter(gl.RENDERBUFFER_BINDING),bytesProduct(args[3],args[4],Math.max(1,args[1]),formatBytes(gl,args[2],null,null)),()=>run.apply(gl,args));});
    function backbuffer(width,height,run) {
      if(bytesProduct(width,height)>allocation.pixelBudget)fail('drawing buffer exceeds native pixel reservation');
      var bytes=bytesProduct(width,height,16),old=state.backbufferBytes||0;
      check(state,state.bytes-old+bytes,state.objects.size);var result=run();state.bytes+=bytes-old;state.backbufferBytes=bytes;return result;
    }
    ['width','height'].forEach(function(key){
      var descriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,key);
      Object.defineProperty(canvas,key,{configurable:true,get:()=>descriptor.get.call(canvas),set:value=>{
        value=Math.floor(Number(value));if(!integer(value))fail('invalid drawing buffer');
        if(value===canvas[key])return;
        // Three changes width and height separately. The final size must be admitted before draw,
        // but every intermediate allocation is still charged against GPU bytes.
        var width=key==='width'?value:canvas.width,height=key==='height'?value:canvas.height;
        var bytes=bytesProduct(width,height,16),old=state.backbufferBytes||0;
        state.poll();
        check(state,state.bytes+bytes,state.objects.size);
        state.bytes+=bytes;state.backbufferBytes=bytes;
        if(old){state.pending.push(old);state.pendingBytes+=old;}
        descriptor.set.call(canvas,value);
      }});
    });
    state.poll=function(){
      for(var i=state.batches.length-1;i>=0;i--) {
        var batch=state.batches[i],status=gl.clientWaitSync(batch.fence,0,0);
        if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED){gl.deleteSync(batch.fence);state.bytes-=batch.bytes;state.pendingBytes-=batch.bytes;state.batches.splice(i,1);}
      }
      if(state.pending.length) {
        if(state.batches.length>=256)fail('GPU retirement fence limit exceeded');
        var fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);
        if(!fence)fail('GPU exit fence unavailable');
        state.batches.push({fence:fence,bytes:state.pending.reduce((sum,n)=>sum+n,0)});state.pending=[];gl.flush();
      }
    };
    state.beforeDraw=function(){backbuffer(canvas.width,canvas.height,()=>{});state.poll();};
    ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced'].forEach(function(name){wrap(name,function(run,args){state.beforeDraw();return run.apply(gl,args);});});
    canvas.addEventListener('webglcontextlost',function(){
      state.closed=true;contexts.delete(state);
      if(contexts.size===0){var ready=waiters;waiters=[];ready.forEach(resolve=>resolve());}
    });
    backbuffer(canvas.width,canvas.height,()=>{});
    return gl;
  }
  if(native) {
    HTMLCanvasElement.prototype.getContext=function(type,options) {
      if(!/^webgl|^experimental-webgl/.test(type))return originalGetContext.apply(this,arguments);
      if(failed)throw new Error(failed);
      if(!allocation) return null;
      for(var state of contexts)if(state.canvas===this)return type==='webgl2'?state.gl:null;
      if(contexts.size>=1)fail('previous GL context has not exited');
      if(type!=='webgl2')return null;
      if(bytesProduct(this.width,this.height)>allocation.pixelBudget||bytesProduct(this.width,this.height,16)>allocation.gpuBytes)fail('initial drawing buffer exceeds reservation');
      var gl=originalGetContext.call(this,type,Object.assign({},options,{antialias:false}));
      return gl?guard(gl,this):null;
    };
    if(allocation && (allocation.generation!==window.__hertzWallpaperBinding.generation
      || !integer(allocation.pixelBudget) || allocation.pixelBudget<1
      || !integer(allocation.gpuBytes) || allocation.gpuBytes<1))fail('invalid native allocation');
  }
  Object.defineProperty(window,'HertzGlBudget',{value:Object.freeze({
    limits:allocation,
    idle:function(){
      if(!native||contexts.size===0)return Promise.resolve();
      return new Promise((resolve,reject)=>{var timer=setTimeout(()=>{var at=waiters.indexOf(done);if(at>=0)waiters.splice(at,1);reject(new Error('gl_budget: old context exit timed out'));},2000);function done(){clearTimeout(timer);resolve();}waiters.push(done);});
    },
    stats:function(){return Object.assign(totals(),{contexts:contexts.size,peakBytes:peakBytes,uploadBytes:uploads,error:failed});}
  }),writable:false,configurable:false});
})();

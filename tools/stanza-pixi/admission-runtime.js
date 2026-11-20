// SPDX-License-Identifier: MIT
// Included inside the pinned Pixi closure by build-stanza-pixi.mjs. This is an
// allocation owner, not a scheduler or a second budget. Browser prototypes are
// untouched: only canvases created by this copy of Pixi and their GL APIs wrap.
const hertzPixiResources = (() => {
  let active = null;
  const pages = new WeakMap(), cpu = new WeakMap();
  function checked(n) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('estimate-unavailable');
    return n;
  }
  function release(ticket) {
    if (ticket) ticket.release({apiReleased:true, allocationEnded:true});
  }
  function page() {
    const ledger = globalThis.Stage && globalThis.Stage.resources && globalThis.Stage.resources();
    if (!ledger || ledger.contractVersion !== 1) throw new Error('resource-port-required');
    let owner = pages.get(ledger);
    if (!owner) { owner = create(ledger.port('stanza-pixi-shared')); pages.set(ledger, owner); }
    return owner;
  }
  function run(owner, fn) {
    const before = active; active = owner || active;
    try { return fn(); } finally { active = before; }
  }
  function create(port) {
    if (!port || port.contractVersion !== 1) throw new Error('resource-port-required');
    const tickets = new Set(), canvases = new Set(), graphicsContexts = new Set();
    let retired = false, cancelled = false, failure = null;
    function reserve(vector, source, precision) {
      if (retired || cancelled) throw new Error('resource-allocation-ended');
      let ticket;
      try { ticket = port.require(vector, 'Pixi 8.20.1: ' + source, 1, precision); }
      catch (error) { failure = error.message; throw error; }
      tickets.add(ticket);
      return ticket;
    }
    function free(ticket) { release(ticket); tickets.delete(ticket); }
    return {port, reserve, free, canvases,
      run(fn) { return run(this, fn); },
      ownGraphics(context) {
        graphicsContexts.add(context);
        context.once('destroy',()=>graphicsContexts.delete(context));
      },
      cancel() { cancelled = true; for (const ticket of tickets) ticket.cancel(); },
      // Called only after the original Application/partial renderer settled
      // and was physically retired. Pending init never calls this early.
      retire() {
        // Rejected construction may own a context before the Graphics is
        // attached. Keep that original object until its actual destruction.
        for (const context of graphicsContexts) if (!context.destroyed) context.destroy();
        graphicsContexts.clear();
        for (const canvas of canvases) canvas._hertzRetire();
        for (const ticket of tickets) release(ticket);
        tickets.clear(); canvases.clear(); retired = true; port.forgetReport();
      },
      snapshot() { return {coverage:'context-canvas-gl-batch-uniform-path-text-payload', complete:false, held:tickets.size, retired, failure}; }
    };
  }
  function replace(owner, previous, vector, source, allocate) {
    const ticket = owner.reserve(vector, source);
    try { const result = allocate(); ticket.commit(); owner.free(previous); return {ticket, result}; }
    catch (error) { owner.free(ticket); throw error; }
  }
  function typed(Type, value, source, owner = page()) {
    // These arrays belong to the original reusable Pixi batch/geometry pool.
    // Sharing one ArrayBuffer through typed views never creates another ticket.
    if (value instanceof ArrayBuffer) return new Type(value);
    const bytes = checked((typeof value === 'number' ? value : value.length) * (Type.BYTES_PER_ELEMENT || 1));
    const ticket = owner.reserve({ownedCpuBytes:bytes}, source);
    try { const result = new Type(value); ticket.commit(); cpu.set(result.buffer || result,{owner,ticket}); return result; }
    catch (error) { owner.free(ticket); throw error; }
  }
  function ownedTyped(Type,value,source) { return typed(Type,value,source,active || page()); }
  function freeUniforms(group) {
    if (!group) return;
    for (const key of Object.keys(group.uniforms || {})) {
      const value = group.uniforms[key];
      if (value && value.array) { freeTyped(value.array); value.array = null; }
      freeTyped(value);
    }
    if (group.buffer) { group.buffer.destroy(); group.buffer = null; }
  }
  function freeUniformData(data) {
    if (data) for (const item of Object.values(data)) freeTyped(item.value);
  }
  function freeTyped(value) {
    const buffer = value && (value.buffer || value), entry = buffer && cpu.get(buffer);
    if (entry) { entry.owner.free(entry.ticket); cpu.delete(buffer); }
  }
  function pathPoints(path) {
    let points = 0, shapes = 0;
    for (const instruction of path.instructions) {
      const a = instruction.data, action = instruction.action;
      if (action === 'moveTo' || action === 'lineTo') { points++; shapes++; }
      else if (action === 'rect') { points += 4; shapes++; }
      else if (action === 'circle' || action === 'ellipse' || action === 'roundRect') {
        const sum = action === 'circle' ? a[2] * 2 : action === 'ellipse' ? a[2] + a[3] : Math.max(0,Math.min(a[4],a[2]/2,a[3]/2)) * 2;
        points += Math.ceil(2.3 * Math.sqrt(Math.max(0,sum))) * 4 + 4; shapes++;
      } else if (action === 'poly') { points += a[0].length / 2; shapes++; }
      else if (action === 'arc') {
        let angle = Math.abs(a[3] - a[4]);
        if ((!a[5] && a[3] > a[4]) || (a[5] && a[4] > a[3])) angle = Math.PI * 2 - angle;
        points += Math.max(6,Math.floor(6 * Math.pow(a[2],1/3) * angle / Math.PI)) + 2; shapes++;
      } else if (action === 'quadraticCurveTo' || action === 'bezierCurveTo') {
        // Both original adaptive subdivisions stop at depth 8; <= 2^8
        // accepted midpoints plus the final endpoint, plus an initial point.
        points += 258; shapes++;
      } else if (action === 'arcToSvg') {
        // ug() splits the normalized SVG arc (<=2π) into at most four
        // quarter-arc cubics; each uses the same depth-8 adaptive builder.
        points += 4 * 258; shapes++;
      } else if (action === 'closePath') points++;
      else if (action === 'addPath') { const child = pathPoints(a[0]); points += child.points; shapes += child.shapes; }
      else throw new Error('estimate-unavailable: pixi-path-' + action);
    }
    return {points:checked(points), shapes:checked(shapes)};
  }
  const paths = new WeakMap(), pathData = new WeakMap();
  function clearPathData(path) {
    const entries=pathData.get(path); if(!entries)return;
    for(const entry of entries)if(--entry.users===0)entry.owner.free(entry.ticket);
    entries.clear();pathData.delete(path);
  }
  function clonePathData(from,to) {
    const entries=pathData.get(from);if(!entries)return;
    const copy=new Set(entries);for(const entry of copy)entry.users++;pathData.set(to,copy);
  }
  function pathCommand(path,args,invoke) {
    // Scalar numeric operands are stored in the command's original data array.
    // Caller-owned polygon arrays remain borrowed until ShapePath copies them.
    const count=Array.prototype.reduce.call(args,(n,value)=>n+(typeof value==='number'?1:0),0);
    const owner=active || page(),ticket=owner.reserve({ownedCpuBytes:checked(count*8)},'GraphicsPath command Float64 operands');
    try {
      const result=invoke();ticket.commit();
      let entries=pathData.get(path);if(!entries){entries=new Set();pathData.set(path,entries);}
      entries.add({owner,ticket,users:1});return result;
    }catch(error){owner.free(ticket);throw error;}
  }
  function pathShape(path, build) {
    const bound = pathPoints(path), old = paths.get(path), owner = active || page();
    // ShapePath retains x/y pairs (including per-shape closure), separate from
    // the GPU geometry representation. Old ShapePath remains until replacement.
    const ticket = owner.reserve({ownedCpuBytes:checked((bound.points + bound.shapes * 2) * 2 * 8)},
      'GraphicsPath shape coordinate payload bound','bounded-estimate');
    try { const result = build(); ticket.commit(); if (old) owner.free(old.ticket);
      paths.set(path,{owner,ticket,users:old ? old.users : new Set()}); return result;
    } catch (error) { owner.free(ticket); throw error; }
  }
  function usePaths(context) {
    const used = context._hertzPaths || (context._hertzPaths = new Set());
    for (const instruction of context.instructions) for (const key of ['path','hole']) {
      const path = instruction.data && instruction.data[key];
      if (!path || used.has(path)) continue;
      let entry = paths.get(path);
      if (!entry) { entry = {owner:active || page(),ticket:null,users:new Set()}; paths.set(path,entry); }
      entry.users.add(context); used.add(path);
    }
  }
  function clearPaths(context) {
    if (!context._hertzPaths) return;
    for (const path of context._hertzPaths) {
      const entry = paths.get(path); if (!entry) continue;
      entry.users.delete(context);
      if (!entry.users.size) { path._shapePath = null; entry.owner.free(entry.ticket); paths.delete(path);clearPathData(path); }
    }
    context._hertzPaths.clear();
  }
  // Metrics LRU owns retained strings and numeric line widths, while the
  // synchronous word-wrap scratch is retired at the call boundary. Font native
  // shaping/glyph caches are browser memory observation, not declared bytes.
  function metrics(cache,text,style,key,wordWrap,compute) {
    if (style.tagStyles && Object.keys(style.tagStyles).length) throw new Error('estimate-unavailable: tagged-text');
    const length = checked(text.length), owner = page();
    const retained = owner.reserve({ownedCpuBytes:checked(key.length * 2 + length * 2 + (length + 1) * 8 + 8 * 8)},
      'TextMetrics cache UTF16 text/key and Float64 line width payload bound','bounded-estimate');
    let scratch;
    try {
      scratch = owner.reserve({ownedCpuBytes:checked((length + 1) * 8 + length * 8)},
        'TextMetrics splitting/wrapping transient UTF16 and numeric payload bound','bounded-estimate');
      const result = compute(); retained.commit(); scratch.commit();
      const evicted = cache.setWithEvicted(key,result);
      if (evicted && evicted.value._hertzMetric) { owner.free(evicted.value._hertzMetric); evicted.value._hertzMetric=null; }
      result._hertzMetric=retained; return result;
    } catch (error) { owner.free(retained); throw error; }
    finally { owner.free(scratch); }
  }
  function fontMetrics(font,compute) {
    const owner=page(), ticket=owner.reserve({ownedCpuBytes:checked(font.length*2+3*8)},'font metrics UTF16 key and three Float64 values');
    try { const result=compute();ticket.commit();result._hertzFont={owner,ticket};return result; }
    catch(error){owner.free(ticket);throw error;}
  }
  function transient(bytes,source,compute) {
    const owner=active || page(),ticket=owner.reserve({ownedCpuBytes:checked(bytes)},source);
    try {const result=compute();ticket.commit();return result;}finally{owner.free(ticket);}
  }
  function freeFonts(fonts,key) {
    const values=key?[fonts[key]]:Object.values(fonts);
    for(const value of values)if(value&&value._hertzFont){value._hertzFont.owner.free(value._hertzFont.ticket);value._hertzFont=null;}
  }
  function graphics(context, gpu) {
    let scalars = 0;
    for (const instruction of context.instructions) {
      if (instruction.action === 'texture') { scalars += 4 * 4 + 6; continue; }
      if (instruction.action !== 'fill' && instruction.action !== 'stroke') throw new Error('estimate-unavailable: pixi-graphics');
      const data = instruction.data;
      if (data.hole) throw new Error('estimate-unavailable: pixi-graphics-holes');
      const bound = pathPoints(data.path), n = bound.points, shapes = bound.shapes;
      let vertices, indices;
      if (instruction.action === 'fill') { vertices = n + shapes; indices = 3 * n; }
      else {
        const style = data.style, alignment = style.alignment;
        const radius = Math.abs(style.width) * Math.max(Math.abs(alignment),Math.abs(1-alignment));
        // buildLine emits <=12 strip vertices per point for miter/bevel.
        // Round joins/caps use the original cr() limit (30*sqrt(radius)+1)
        // at a full 2π sweep, two vertices per segment plus endpoints.
        const round = style.join === 'round' || style.cap === 'round' ? 2 * (Math.ceil(30 * Math.sqrt(radius)) + 3) : 0;
        vertices = (n + shapes * 2) * (12 + round);
        indices = style.pixelLine ? vertices * 2 : vertices * 3;
      }
      // Live Float64 JS numeric payload: x/y vertices + u/v + indices.
      // Scratch: builder copy, stroke copy/closure, earcut
      // output and copied path coordinates coexist (<=12n+8*shapes scalars).
      // Object headers and JS engine array capacity are observation, not bytes.
      scalars += vertices * 4 + indices + n * 10 + shapes * 4;
    }
    const owner = active || page(), ticket = owner.reserve({ownedCpuBytes:checked(scalars * 8)}, 'GraphicsContext path/tessellation numeric payload upper bound', 'bounded-estimate');
    ticket.commit(); gpu._hertzGeometry = {owner,ticket};
  }
  function freeGraphics(gpu) {
    if (gpu._hertzGeometry) { gpu._hertzGeometry.owner.free(gpu._hertzGeometry.ticket); gpu._hertzGeometry = null; }
  }
  // Source-owned canvas creation, used by the renderer, text raster pool and
  // original capability probes. Dimensions are reserved before native setters.
  function canvas(width = 0, height = 0, owner = active || page()) {
    width = checked(Math.trunc(width || 0)); height = checked(Math.trunc(height || 0));
    const slot = owner.reserve({canvases:1}, 'canvas object');
    let surface;
    try { surface = owner.reserve({ownedCpuBytes:checked(width * height * 4)}, 'initial RGBA8 canvas backing'); }
    catch (error) { owner.free(slot); throw error; }
    let node;
    try { node = document.createElement('canvas'); node.width = width; node.height = height; slot.commit(); surface.commit(); }
    catch (error) { owner.free(surface); owner.free(slot); throw error; }
    let pixels = surface, contextTicket = null, glState = null, kind = '2d', ended = false;
    const nativeGet = node.getContext.bind(node);
    const descriptors = Object.fromEntries(['width', 'height'].map(key => [key, Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, key)]));
    for (const key of ['width', 'height']) Object.defineProperty(node, key, {
      configurable:true, get() { return descriptors[key].get.call(node); },
      set(value) {
        const size = checked(Number(value));
        const w = key === 'width' ? size : node.width, h = key === 'height' ? size : node.height;
        const vector = kind === '2d' ? {ownedCpuBytes:checked(w * h * 4)} : {drawingBufferPixels:checked(w * h)};
        const next = replace(owner, pixels, vector, kind + ' canvas backing replacement', () => descriptors[key].set.call(node, size));
        pixels = next.ticket;
      }
    });
    node.getContext = function(type, options) {
      if (!/^(webgl2?|experimental-webgl)$/.test(type)) return nativeGet(type, options);
      if (glState) return glState.proxy;
      let next, nextPixels, gl;
      try {
        next = owner.reserve({gpuContexts:1}, 'original WebGL context');
        nextPixels = owner.reserve({drawingBufferPixels:checked(node.width * node.height)}, 'default surface pixels');
        gl = nativeGet(type, options);
      } catch (error) { owner.free(next); owner.free(nextPixels); throw error; }
      if (!gl) { owner.free(next); owner.free(nextPixels); return null; }
      next.commit(); nextPixels.commit(); owner.free(pixels); pixels = nextPixels; contextTicket = next; kind = 'webgl';
      glState = wrapGL(gl, owner);
      return glState.proxy;
    };
    node._hertzRetire = function() {
      if (ended) return;
      // Raw setters during retirement have no new allocation authority.
      if (glState) glState.retire();
      descriptors.width.set.call(node, 0); descriptors.height.set.call(node, 0);
      owner.free(contextTicket); owner.free(pixels); owner.free(slot);
      owner.canvases.delete(node); ended = true;
    };
    owner.canvases.add(node);
    return node;
  }
  function formatBytes(gl, internal, format, type) {
    const sized = new Map([[gl.R8,1],[gl.RG8,2],[gl.RGB8,3],[gl.RGBA8,4],[gl.SRGB8_ALPHA8,4],
      [gl.R16F,2],[gl.RG16F,4],[gl.RGBA16F,8],[gl.R32F,4],[gl.RG32F,8],[gl.RGBA32F,16],
      [gl.DEPTH_COMPONENT16,2],[gl.DEPTH_COMPONENT24,4],[gl.DEPTH_COMPONENT32F,4],
      [gl.DEPTH24_STENCIL8,4],[gl.DEPTH32F_STENCIL8,8],[gl.DEPTH_STENCIL,4],[gl.STENCIL_INDEX8,1]]);
    if (internal !== undefined && sized.has(internal)) return sized.get(internal);
    if ([gl.UNSIGNED_SHORT_4_4_4_4,gl.UNSIGNED_SHORT_5_5_5_1,gl.UNSIGNED_SHORT_5_6_5].includes(type)) return 2;
    if (type === gl.UNSIGNED_INT_24_8 || type === gl.UNSIGNED_INT_2_10_10_10_REV) return 4;
    const channels = format === gl.RGBA ? 4 : format === gl.RGB ? 3 : format === gl.RG ? 2
      : [gl.RED,gl.ALPHA,gl.LUMINANCE,gl.DEPTH_COMPONENT].includes(format) ? 1 : format === gl.LUMINANCE_ALPHA ? 2 : 0;
    const component = type === gl.UNSIGNED_BYTE ? 1 : [gl.UNSIGNED_SHORT,gl.HALF_FLOAT,36193].includes(type) ? 2
      : [gl.UNSIGNED_INT,gl.FLOAT].includes(type) ? 4 : 0;
    if (!channels || !component) throw new Error('estimate-unavailable');
    return channels * component;
  }
  function wrapGL(gl, owner) {
    const objects = new Map(), buffers = new Map(), textures = new Map(), methods = new Map();
    let unit = gl.TEXTURE0, renderbuffer = null, textureKind = 'textureDeclaredBytes';
    function row(object) { if (!object) throw new Error('estimate-unavailable'); if (!objects.has(object)) objects.set(object, new Map()); return objects.get(object); }
    function storage(object, key, vector, source, invoke) {
      const entries = row(object), old = entries.get(key);
      const next = replace(owner, old, vector, source, invoke); entries.set(key, next.ticket); return next.result;
    }
    function drop(object) { const entries = objects.get(object); if (entries) for (const ticket of entries.values()) owner.free(ticket); objects.delete(object); }
    const api = {
      _hertzSource(source) { textureKind = source._hertzRenderAttachment ? 'renderTargetDeclaredBytes' : 'textureDeclaredBytes'; },
      createTexture() { const object = gl.createTexture(); if (object) row(object).kind = textureKind; return object; },
      createProgram() {
        const ticket = owner.reserve({programs:1}, 'WebGL program');
        let object;
        try { object = gl.createProgram(); } catch (error) { owner.free(ticket); throw error; }
        if (!object) { owner.free(ticket); return object; }
        ticket.commit(); row(object).set('program', ticket); return object;
      },
      bindBuffer(target, object) { buffers.set(target, object); return gl.bindBuffer(target, object); },
      bufferData(target, data, usage, offset, length) {
        const bytes = typeof data === 'number' ? data : length !== undefined && length !== 0 ? length * data.BYTES_PER_ELEMENT
          : data.byteLength - (offset || 0) * (data.BYTES_PER_ELEMENT || 1);
        const args = arguments;
        return storage(buffers.get(target), 'storage', {bufferDeclaredBytes:checked(bytes)}, 'GPU buffer capacity replacement', () => gl.bufferData(...args));
      },
      activeTexture(value) { unit = value; return gl.activeTexture(value); },
      bindTexture(target, object) { textures.set(unit + ':' + target, object); return gl.bindTexture(target, object); },
      texImage2D(...args) {
        const [target, level, internal] = args, image = args.length < 9 ? args[5] : null;
        const width = image ? image.width : args[3], height = image ? image.height : args[4];
        const format = image ? args[3] : args[6], type = image ? args[4] : args[7];
        const object = textures.get(unit + ':' + target), dimension = row(object).kind || 'textureDeclaredBytes';
        return storage(object, 'level:' + level, {[dimension]:checked(width * height * formatBytes(gl,internal,format,type))},
          'texture level ' + level + ' (' + internal + '/' + format + '/' + type + ')', () => gl.texImage2D(...args));
      },
      generateMipmap(target) {
        // Stanza has no mipmap candidate. Refuse an unexpected source extension
        // before driver allocation instead of silently guessing its footprint.
        throw new Error('estimate-unavailable: pixi-mipmap');
      },
      bindRenderbuffer(target, object) { renderbuffer = object; return gl.bindRenderbuffer(target, object); },
      renderbufferStorage(target, format, width, height) {
        return storage(renderbuffer,'storage',{renderTargetDeclaredBytes:checked(width * height * formatBytes(gl,format))},
          'single-sample renderbuffer ' + format, () => gl.renderbufferStorage(target,format,width,height));
      },
      renderbufferStorageMultisample(target, samples, format, width, height) {
        return storage(renderbuffer,'storage',{renderTargetDeclaredBytes:checked(width * height * samples * formatBytes(gl,format))},
          samples + '-sample renderbuffer ' + format, () => gl.renderbufferStorageMultisample(target,samples,format,width,height));
      }
    };
    for (const kind of ['Buffer','Texture','Program','Renderbuffer']) api['delete' + kind] = function(object) {
      gl['delete' + kind](object); drop(object);
    };
    // Unsupported paths fail before allocation. Current lyrics use only 2D
    // textures, exact level replacement and the renderbuffer methods above.
    for (const name of ['texImage3D','texStorage2D','texStorage3D','compressedTexImage2D','compressedTexImage3D','copyTexImage2D']) api[name] = function() {
      throw new Error('estimate-unavailable: pixi-' + name);
    };
    const proxy = new Proxy(gl, {get(target,key) {
      if (key in api) return api[key];
      const value = Reflect.get(target,key,target);
      if (typeof value !== 'function') return value;
      if (!methods.has(key)) methods.set(key,value.bind(target)); return methods.get(key);
    }});
    return {proxy, retire() {
      const extension = gl.getExtension('WEBGL_lose_context');
      if (extension && !gl.isContextLost()) extension.loseContext();
      if (!gl.isContextLost()) throw new Error('pixi-context-cleanup-unconfirmed');
      for (const object of objects.keys()) drop(object);
    }};
  }
  return {create, run, canvas, page, typed, ownedTyped, freeTyped, freeUniforms, freeUniformData, graphics, freeGraphics,
    pathShape,usePaths,clearPaths,metrics,fontMetrics,freeFonts,clearPathData,clonePathData,pathCommand,transient,
    manageGraphics(context) { if(active)active.ownGraphics(context); },
    markAttachments(target) {
      if (!target.isRoot) {
        for (const item of target.colorAttachments) item.texture._hertzRenderAttachment=true;
        if (target.depthStencilAttachment) target.depthStencilAttachment.texture._hertzRenderAttachment=true;
      }
    },
    // Pinned module constants: WHITE texel 4; filter quad 32+24; empty batch
    // 4+4; tiling quad As 32+32+24; backbuffer triangle y3 6*4 = 180 bytes.
    bootstrap() { const ticket = page().reserve({ownedCpuBytes:180}, 'module typed backings: WHITE4+filter56+batch8+tiling88+backbuffer24'); ticket.commit(); },
    sharedCanvas(width,height) { return canvas(width,height,page()); },
    retireCanvas(value) { if (value && value._hertzRetire) value._hertzRetire(); }
  };
})();

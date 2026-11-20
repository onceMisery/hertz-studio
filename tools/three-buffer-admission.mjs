// SPDX-License-Identifier: MIT
// Admit original WebGLAttributes cache misses, including implicit geometry
// buffers. Explicit scope plans lend their already reserved upload envelope.
export function withBufferAdmission(source) {
  source = source.replace(/\r\n/g, '\n');
  function replaceOnce(text, from, to) {
    if (text.split(from).length !== 2) throw new Error('Three buffer admission source changed: ' + from);
    return text.replace(from, to);
  }
  const start = source.indexOf('function WebGLAttributes( gl ) {');
  const end = source.indexOf('\nfunction ', start + 1);
  if (start < 0 || end < start) throw new Error('Three WebGLAttributes source changed');
  let body = source.slice(start, end);
  body = replaceOnce(body, 'function WebGLAttributes( gl ) {', 'function WebGLAttributes( gl, getResources ) {');
  body = replaceOnce(body, '\t\tconst size = array.byteLength;', `\t\tconst size = array.byteLength;
\t\tconst borrowed = attribute.hertzBufferAdmission;
\t\tif (borrowed) {
\t\t\tconst state = borrowed.state();
\t\t\tif (state.released || (state.pending.bufferDeclaredBytes < size && attribute.hertzBufferAllocatedBytes !== size))
\t\t\t\tthrow new Error('buffer-plan-retired-or-exhausted');
\t\t}
\t\tconst admission = borrowed || getResources?.()?.require({ bufferDeclaredBytes: size },
\t\t\t'Three original attribute-cache buffer capacity', 0);
\t\tlet buffer = null;
\t\ttry {`);
  body = replaceOnce(body, '\t\tconst buffer = gl.createBuffer();', `\t\tbuffer = gl.createBuffer();
\t\tif (!buffer) throw new Error('Three buffer allocation failed');`);
  body = replaceOnce(body, '\t\tgl.bufferData( bufferType, array, usage );', `\t\tgl.bufferData( bufferType, array, usage );
\t\tif (!borrowed && admission && !admission.commit().ok) throw new Error('Three buffer admission violated');
\t\tif (!borrowed) attribute.hertzImplicitBufferResourceId = admission?.resourceId;`);
  body = replaceOnce(body, '\t\tif (!borrowed) attribute.hertzImplicitBufferResourceId = admission?.resourceId;', `\t\tif (!borrowed) {
\t\t\tattribute.hertzImplicitBufferResourceId = admission?.resourceId;
\t\t\tif (attribute.hertzWireframeGeometry) attribute.hertzWireframeGeometry.hertzWireframeGpuResourceId = admission?.resourceId;
\t\t}`);
  body = replaceOnce(body, '\t\tattribute.onUploadCallback();\n\n\t\tlet type;', '\t\tattribute.onUploadCallback();\n\t\tif (borrowed) attribute.hertzBufferAllocatedBytes = size;\n\n\t\tlet type;');
  body = replaceOnce(body, '\t\t\tbuffer: buffer,', '\t\t\tbuffer: buffer, hertzAdmission: borrowed ? null : admission,');
  body = replaceOnce(body, '\n\t}\n\n\tfunction updateBuffer', `
\t\t} catch (error) {
\t\t\tlet cleaned = true;
\t\t\tif (buffer) try { gl.deleteBuffer(buffer); } catch (_) { cleaned = false; }
\t\t\tif (!borrowed) {
\t\t\t\tadmission?.cancel();
\t\t\t\tif (cleaned) admission?.release({ apiReleased: true, allocationEnded: true });
\t\t\t}
\t\t\tthrow error;
\t\t}
\t}

\tfunction updateBuffer`);
  body = replaceOnce(body, '\t\t\tgl.deleteBuffer( data.buffer );', `\t\t\tgl.deleteBuffer( data.buffer );
\t\t\tdata.hertzAdmission?.release({ apiReleased: true, allocationEnded: true });
\t\t\tif (attribute.hertzImplicitBufferResourceId === data.hertzAdmission?.resourceId) delete attribute.hertzImplicitBufferResourceId;`);
  body = replaceOnce(body, '\t\t\tdata.hertzAdmission?.release({ apiReleased: true, allocationEnded: true });', `\t\t\tdata.hertzAdmission?.release({ apiReleased: true, allocationEnded: true });
\t\t\tif (attribute.hertzWireframeGeometry && attribute.hertzWireframeGeometry.hertzWireframeGpuResourceId === data.hertzAdmission?.resourceId)
\t\t\t\tdelete attribute.hertzWireframeGeometry.hertzWireframeGpuResourceId;`);
  source = source.slice(0, start) + body + source.slice(end);
  source = replaceOnce(source, 'attributes = new WebGLAttributes( _gl );',
    'attributes = new WebGLAttributes( _gl, () => _this.hertzBufferResources );');
  // Wireframe indices are constructed lazily by the original geometry cache,
  // after the authored geometry source has settled. Keep their CPU ownership
  // here, independent of the attribute cache's per-context GPU upload ticket.
  const geometryStart = source.indexOf('function WebGLGeometries( gl, attributes, info, bindingStates ) {');
  const geometryEnd = source.indexOf('\nfunction ', geometryStart + 1);
  if (geometryStart < 0 || geometryEnd < geometryStart) throw new Error('Three WebGLGeometries source changed');
  let geometry = source.slice(geometryStart, geometryEnd);
  geometry = replaceOnce(geometry, 'function WebGLGeometries( gl, attributes, info, bindingStates ) {',
    'function WebGLGeometries( gl, attributes, info, bindingStates, getResources ) {');
  geometry = replaceOnce(geometry, '\t\t\tattributes.remove( attribute );', `\t\t\tattributes.remove( attribute );
\t\t\tattribute.hertzWireframeCpu?.release({ apiReleased: true, allocationEnded: true });
\t\t\tdelete geometry.hertzWireframeCpuResourceId;`);
  geometry = replaceOnce(geometry, '\t\tconst indices = [];', '\t\tlet indices = null;');
  geometry = replaceOnce(geometry, '\t\tif ( geometryIndex !== null ) {\n\n\t\t\tconst array = geometryIndex.array;', `\t\tconst count = geometryIndex ? Math.ceil(geometryIndex.array.length / 3) * 6
\t\t\t: Math.ceil(Math.max(0, geometryPosition.array.length / 3 - 1) / 3) * 6;
\t\tconst retainedBytes = count * (geometryPosition.count >= 65535 ? 4 : 2);
\t\tconst cpu = getResources?.()?.require({ ownedCpuBytes: count * 8 + retainedBytes },
\t\t\t'Three original wireframe cache numeric construction and typed index backing', 0);
\t\ttry {
\t\tindices = [];
\t\tif ( geometryIndex !== null ) {
\t\t\tconst array = geometryIndex.array;`);
  geometry = replaceOnce(geometry, '\t\tif ( previousAttribute ) attributes.remove( previousAttribute );', `\t\tif ( previousAttribute ) {
\t\t\tattributes.remove( previousAttribute );
\t\t\tpreviousAttribute.hertzWireframeCpu?.release({ apiReleased: true, allocationEnded: true });
\t\t}`);
  geometry = replaceOnce(geometry, '\t\twireframeAttributes.set( geometry, attribute );', `\t\tindices = null;
\t\tif (cpu && !cpu.commit({ ownedCpuBytes: attribute.array.byteLength }).ok) throw new Error('wireframe-source-plan-exceeded');
\t\tattribute.hertzWireframeCpu = cpu;
\t\tattribute.hertzWireframeGeometry = geometry;
\t\tgeometry.hertzWireframeCpuResourceId = cpu?.resourceId;
\t\twireframeAttributes.set( geometry, attribute );
\t\t} catch (error) {
\t\t\tindices = null; cpu?.release({ apiReleased: true, allocationEnded: true }); throw error;
\t\t}`);
  source = source.slice(0, geometryStart) + geometry + source.slice(geometryEnd);
  return replaceOnce(source, 'geometries = new WebGLGeometries( _gl, attributes, info, bindingStates );',
    'geometries = new WebGLGeometries( _gl, attributes, info, bindingStates, () => _this.hertzBufferResources );');
}

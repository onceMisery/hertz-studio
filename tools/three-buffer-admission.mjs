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
  source = source.slice(0, start) + body + source.slice(end);
  return replaceOnce(source, 'attributes = new WebGLAttributes( _gl );',
    'attributes = new WebGLAttributes( _gl, () => _this.hertzBufferResources );');
}

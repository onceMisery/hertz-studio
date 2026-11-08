// SPDX-License-Identifier: MIT
// A pinned build-time seam in the original Three program/cache owner. The
// renderer's optional injected port is consulted only on an actual cache miss.
export function withProgramAdmission(source) {
  source = source.replace(/\r\n/g, '\n');
  function replaceOnce(text, from, to) {
    if (text.split(from).length !== 2) throw new Error('Three program admission source changed: ' + from);
    return text.replace(from, to);
  }
  const start = source.indexOf('function WebGLProgram( renderer, cacheKey, parameters, bindingStates ) {');
  const end = source.indexOf('\n\treturn this;\n\n}', start) + '\n\treturn this;\n\n}'.length;
  if (start < 0 || end < start) throw new Error('Three WebGLProgram source changed');
  let body = source.slice(start, end);
  body = replaceOnce(body, '\tconst gl = renderer.getContext();', `\tconst gl = renderer.getContext();
\tconst admission = renderer.hertzProgramResources?.require({ programs: 1 },
\t\t'Three original cache-miss program and partial shader lifetime', 0);
\tlet program = null, glVertexShader = null, glFragmentShader = null;
\ttry {`);
  body = replaceOnce(body, '\tconst program = gl.createProgram();', `\tprogram = gl.createProgram();
\tif (!program) throw new Error('Three program allocation failed');
\tif (admission && !admission.commit().ok) throw new Error('Three program admission violated');`);
  body = replaceOnce(body, 'const glVertexShader = WebGLShader(', 'glVertexShader = WebGLShader(');
  body = replaceOnce(body, 'const glFragmentShader = WebGLShader(', 'glFragmentShader = WebGLShader(');
  body = replaceOnce(body, `\t\tgl.deleteProgram( program );
\t\tthis.program = undefined;`, `\t\tif (glVertexShader) gl.deleteShader(glVertexShader);
\t\tif (glFragmentShader) gl.deleteShader(glFragmentShader);
\t\tif (program) gl.deleteProgram(program);
\t\tprogram = glVertexShader = glFragmentShader = null;
\t\tthis.program = this.vertexShader = this.fragmentShader = undefined;
\t\tadmission?.release({ apiReleased: true, allocationEnded: true });`);
  body = replaceOnce(body, '\treturn this;', `\tthis.hertzProgramResourceId = admission?.resourceId;
\treturn this;
\t} catch (error) {
\t\tlet cleanupFailed = !!error.hertzProgramCleanupFailed;
\t\tfor (const shader of [glVertexShader, glFragmentShader]) {
\t\t\tif (shader) try { gl.deleteShader(shader); } catch (_) { cleanupFailed = true; }
\t\t}
\t\tif (program) try { gl.deleteProgram(program); } catch (_) { cleanupFailed = true; }
\t\tadmission?.cancel();
\t\tif (!cleanupFailed) admission?.release({ apiReleased: true, allocationEnded: true });
\t\telse error.hertzProgramCleanupFailed = true;
\t\tthrow error;
\t}`);
  source = source.slice(0, start) + body + source.slice(end);
  // WebGLShader must retire a partially created shader before its caller can
  // confirm program cleanup. Preserve unknown cleanup as held quota.
  source = replaceOnce(source, `\tgl.shaderSource( shader, string );
\tgl.compileShader( shader );`, `\tif (!shader) throw new Error('Three shader allocation failed');
\ttry {
\t\tgl.shaderSource(shader, string);
\t\tgl.compileShader(shader);
\t} catch (error) {
\t\ttry { gl.deleteShader(shader); } catch (_) { error.hertzProgramCleanupFailed = true; }
\t\tthrow error;
\t}`);
  return source;
}

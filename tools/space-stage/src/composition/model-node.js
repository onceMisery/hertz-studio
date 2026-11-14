// SPDX-License-Identifier: MIT
// Static GLB adapter kept in its own module so the text layout owner remains
// import-free; it consumes the installed Three loader profiles and admissions.
import { parseStaticModel, parseTexturedModel } from './model-resource.js';
const TEXTURED_PROFILE = 'static-pbr-texture-v1';
const releaseTicket = ticket => typeof ticket?.release === 'function'
  ? ticket.release({ apiReleased: true, allocationEnded: true }) : undefined;

export async function loadModelResource(requirement, signal, admissions) {
  const cpu = admissions?.cpu, decode = admissions?.decode, upload = admissions?.upload;
  const bufferPlan = admissions?.bufferPlan, textured = requirement.modelFacts?.profile === TEXTURED_PROFILE;
  try {
    if (!bufferPlan) throw new Error('composition-model-admission-required');
    const response = await fetch(requirement.url, { signal });
    if (!response.ok) throw new Error('composition-model-source-unavailable');
    const buffer = await response.arrayBuffer();
    if (signal?.aborted) throw new DOMException('Composition cancelled', 'AbortError');
    if (buffer.byteLength !== requirement.byteLength) throw new Error('composition-model-content-size-mismatch');
    const options = textured
      ? { signal, admissions: { cpu }, bufferPlan, textureUrl: uri => requirement.textureUrls?.[uri] ?? null }
      : { signal, admissions: { cpu }, bufferPlan };
    const resource = textured
      ? await parseTexturedModel(buffer, requirement.modelFacts, options)
      : await parseStaticModel(buffer, requirement.modelFacts, options);
    cpu?.commit();
    if (textured) { upload?.commit(); releaseTicket(decode); }
    return { model: resource,
      release() { resource.dispose(); releaseTicket(cpu); releaseTicket(upload); },
      retirementCandidates: () => [cpu, upload].map(ticket => ticket?.resourceId).filter(Boolean) };
  } catch (error) {
    releaseTicket(cpu); releaseTicket(upload); releaseTicket(decode);
    throw error;
  }
}

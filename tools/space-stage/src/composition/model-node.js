// SPDX-License-Identifier: MIT
// Static GLB adapter kept in its own module so the text layout owner remains
// import-free; it consumes the installed Three loader profiles and admissions.
import { parseKtx2Model, parseStaticModel, parseTexturedModel } from './model-resource.js';
const TEXTURED_PROFILE = 'static-pbr-texture-v1';
const KTX2_PROFILE = 'static-ktx2-texture-v1';
const releaseTicket = ticket => typeof ticket?.release === 'function'
  ? ticket.release({ apiReleased: true, allocationEnded: true }) : undefined;

export async function loadModelResource(requirement, signal, admissions) {
  const cpu = admissions?.cpu, decode = admissions?.decode, upload = admissions?.upload;
  const bufferPlan = admissions?.bufferPlan, renderer = admissions?.renderer;
  const profile = requirement.modelFacts?.profile, textured = profile === TEXTURED_PROFILE, ktx2 = profile === KTX2_PROFILE;
  try {
    if (!bufferPlan) throw new Error('composition-model-admission-required');
    const response = await fetch(requirement.url, { signal });
    if (!response.ok) throw new Error('composition-model-source-unavailable');
    const buffer = await response.arrayBuffer();
    if (signal?.aborted) throw new DOMException('Composition cancelled', 'AbortError');
    if (buffer.byteLength !== requirement.byteLength) throw new Error('composition-model-content-size-mismatch');
    const options = textured || ktx2
      ? { signal, admissions: { cpu }, bufferPlan, renderer,
        textureUrl: uri => requirement.textureUrls?.[uri] ?? null }
      : { signal, admissions: { cpu }, bufferPlan };
    const resource = ktx2
      ? await parseKtx2Model(buffer, requirement.modelFacts, options)
      : textured
        ? await parseTexturedModel(buffer, requirement.modelFacts, options)
        : await parseStaticModel(buffer, requirement.modelFacts, options);
    cpu?.commit();
    if (textured || ktx2) { upload?.commit(); releaseTicket(decode); }
    return { model: resource,
      release() { resource.dispose(); releaseTicket(cpu); releaseTicket(upload); },
      retirementCandidates: () => [cpu, upload].map(ticket => ticket?.resourceId).filter(Boolean) };
  } catch (error) {
    releaseTicket(cpu); releaseTicket(upload); releaseTicket(decode);
    throw error;
  }
}

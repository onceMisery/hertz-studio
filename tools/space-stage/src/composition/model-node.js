// SPDX-License-Identifier: MIT
// Static GLB adapter kept in its own module so the text layout owner remains
// import-free; it consumes the installed Three loader profile and admissions.
import { parseStaticModel } from './model-resource.js';
const releaseTicket = ticket => typeof ticket?.release === 'function'
  ? ticket.release({ apiReleased: true, allocationEnded: true }) : undefined;

export async function loadModelResource(requirement, signal, admissions) {
  const cpu = admissions?.cpu, bufferPlan = admissions?.bufferPlan;
  if (!bufferPlan) throw new Error('composition-model-admission-required');
  const response = await fetch(requirement.url, { signal });
  if (!response.ok) throw new Error('composition-model-source-unavailable');
  const buffer = await response.arrayBuffer();
  if (signal?.aborted) throw new DOMException('Composition cancelled', 'AbortError');
  if (buffer.byteLength !== requirement.byteLength) throw new Error('composition-model-content-size-mismatch');
  const resource = await parseStaticModel(buffer, requirement.modelFacts, { signal, admissions: { cpu }, bufferPlan });
  cpu?.commit();
  const tickets = Object.values(admissions || {}).filter(Boolean);
  return { model: resource, release() { resource.dispose(); releaseTicket(cpu); },
    retirementCandidates: () => tickets.map(ticket => ticket?.resourceId).filter(Boolean) };
}

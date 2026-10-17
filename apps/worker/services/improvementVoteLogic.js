export const IMPROVEMENT_VOTES = Object.freeze(['APOYAR', 'RECHAZAR', 'ABSTENERSE']);

export function parseImprovementVote(value) {
  const text = String(value || '');
  const firstLine = text.replace(/\r/g, '').split('\n').find(line => line.trim())?.trim() || '';
  const match = firstLine.match(/^VOTO\s*[:：-]\s*(APOYAR|RECHAZAR|ABSTENERSE)\s*$/i);
  const vote = match ? match[1].toUpperCase() : 'ABSTENERSE';
  const rationale = text
    .replace(/\r/g, '')
    .replace(/^\s*VOTO\s*[:：-].*$/im, '')
    .replace(/^\s*(?:JUSTIFICACIÓN|JUSTIFICACION)\s*[:：-]\s*/im, '')
    .trim()
    .slice(0, 1800);
  return { vote, validFormat: Boolean(match), rationale: rationale || (match ? 'El agente no proporcionó argumentos adicionales.' : 'El agente no entregó un voto en el formato esperado.') };
}

export function findReusableImprovementVote(votes = [], proposal = '') {
  const normalized = String(proposal || '').trim().toLocaleLowerCase();
  if (!normalized) return null;
  return [...(Array.isArray(votes) ? votes : [])].reverse().find(item =>
    String(item?.proposal || '').trim().toLocaleLowerCase() === normalized &&
    ['completed', 'partial'].includes(item?.status)
  ) || null;
}

export function summarizeImprovementVotes(votes = []) {
  const tally = { APOYAR: 0, RECHAZAR: 0, ABSTENERSE: 0 };
  for (const item of Array.isArray(votes) ? votes : []) {
    if (item?.error != null || item?.responseReceived !== true) continue;
    const vote = String(item?.vote || '').toUpperCase();
    if (Object.hasOwn(tally, vote)) tally[vote] += 1;
    else tally.ABSTENERSE += 1;
  }
  let outcome = 'EMPATE';
  let summary = 'La votación quedó empatada. Revisá los argumentos y decidí manualmente.';
  if (tally.APOYAR > tally.RECHAZAR) {
    outcome = 'MAYORIA_A_FAVOR';
    summary = 'La mayoría de los votos válidos recomienda considerar la mejora. La votación no aplica cambios: requiere tu aprobación y una implementación verificada.';
  } else if (tally.RECHAZAR > tally.APOYAR) {
    outcome = 'MAYORIA_EN_CONTRA';
    summary = 'La mayoría de los votos válidos desaconseja aplicar la mejora tal como está planteada. Revisá los riesgos o reformulá la propuesta.';
  }
  const answered = (Array.isArray(votes) ? votes : []).filter(item => item?.error == null && item?.responseReceived === true).length;
  const total = Array.isArray(votes) ? votes.length : 0;
  return { tally, outcome: answered === 0 ? 'SIN_VOTOS_VALIDOS' : outcome, summary: answered === 0 ? 'No se obtuvieron votos válidos del proveedor. Revisá la configuración y volvé a intentarlo.' : summary, answered, total };
}

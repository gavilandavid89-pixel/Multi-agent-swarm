/**
 * Deterministic integrity gate for agent deliverables.
 * This does not claim runtime correctness; it blocks empty/truncated artifacts
 * and malformed JSON when the task explicitly asks for JSON.
 */
function extractJsonPayload(delivery) {
  const source = String(delivery || '').trim();
  const fenced = [...source.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/gi)];
  if (fenced.length === 1 && /^\s*```json\b/i.test(source)) return fenced[0][1].trim();
  if (/^[\[{]/.test(source) && /[\]}]$/.test(source)) return source;
  return null;
}

export function validateDeliverableIntegrity({ objective = '', delivery = '', validation = null, syntax = null } = {}) {
  const content = String(delivery ?? '').trim();
  const findings = [];
  if (!content) {
    findings.push('La entrega está vacía; no se puede aprobar una tarea sin contenido verificable.');
  }
  if (content && /(?:\[\s*(?:TRUNCATED|TRUNCADO|OUTPUT TRUNCATED)\s*\]|\b(?:CONTINUARÁ EN LA PRÓXIMA RESPUESTA|CONTINUES IN NEXT RESPONSE)\b)/i.test(content)) {
    findings.push('La entrega contiene una marca explícita de truncamiento o continuación pendiente.');
  }
  const fenceCount = (content.match(/```/g) || []).length;
  if (fenceCount % 2 !== 0) findings.push('La entrega termina con un bloque de código Markdown sin cerrar; puede estar truncada.');
  const fileHeaders = [...content.matchAll(/^#{1,6}\s+(?:Archivo|File|Ruta)\s*:\s*(.+)$/gim)];
  if (fileHeaders.length) {
    const lastHeaderIndex = fileHeaders[fileHeaders.length - 1].index;
    const lastSection = content.slice(lastHeaderIndex);
    if (!/```[^\n]*\n[\s\S]*?\n```/.test(lastSection)) {
      findings.push('La última sección de archivo no contiene un bloque de código completo.');
    }
  }
  const asksForJson = /\b(json|objeto JSON|respuesta JSON|formato JSON|JSON válido)\b/i.test(String(objective || ''));
  if (asksForJson && content) {
    const json = extractJsonPayload(content);
    if (json !== null) {
      try { JSON.parse(json); }
      catch { findings.push('La tarea solicita JSON, pero el objeto entregado no se puede analizar como JSON válido.'); }
    } else if (/^```json\b/i.test(content) || /^[\[{]/.test(content)) {
      findings.push('La tarea solicita JSON, pero no se pudo aislar un objeto JSON completo.');
    }
  }
  if (syntax && syntax.checked === false && /\b(?:código|programa|archivo|implementa|desarrolla|aplicación|script)\b/i.test(String(objective || ''))) {
    findings.push('La tarea parece requerir código, pero no se detectó ningún archivo o bloque verificable.');
  }
  return { ok: findings.length === 0, findings, checks: ['non_empty', 'truncation_markers', 'markdown_fences', 'file_sections', 'requested_json'] };
}

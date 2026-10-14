import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImprovementVote, summarizeImprovementVotes } from '../apps/worker/services/improvementVoteLogic.js';

test('parsea voto explícito y conserva la justificación', () => {
  const result = parseImprovementVote('VOTO: APOYAR\nJUSTIFICACIÓN: Reduce errores visibles.\nRIESGO PRINCIPAL: Cambios de API.');
  assert.equal(result.vote, 'APOYAR');
  assert.equal(result.validFormat, true);
  assert.match(result.rationale, /Reduce errores visibles/);
});

test('un formato de voto inválido no se cuenta como una respuesta válida', () => {
  const result = parseImprovementVote('Creo que es buena idea, adelante.');
  assert.equal(result.vote, 'ABSTENERSE');
  assert.equal(result.validFormat, false);
});

test('resume mayoría a favor sin convertir la votación en aprobación automática', () => {
  const summary = summarizeImprovementVotes([
    { vote: 'APOYAR', responseReceived: true },
    { vote: 'APOYAR', responseReceived: true },
    { vote: 'RECHAZAR', responseReceived: true },
    { vote: 'ABSTENERSE', responseReceived: true },
    { vote: 'ABSTENERSE', responseReceived: true }
  ]);
  assert.equal(summary.outcome, 'MAYORIA_A_FAVOR');
  assert.deepEqual(summary.tally, { APOYAR: 2, RECHAZAR: 1, ABSTENERSE: 2 });
  assert.equal(summary.answered, 5);
  assert.match(summary.summary, /no aplica cambios/i);
});

test('un empate entre apoyo y rechazo se declara empate', () => {
  const summary = summarizeImprovementVotes([
    { vote: 'APOYAR', responseReceived: true },
    { vote: 'RECHAZAR', responseReceived: true },
    { vote: 'ABSTENERSE', responseReceived: true }
  ]);
  assert.equal(summary.outcome, 'EMPATE');
});

test('fallos del proveedor no se cuentan como votos válidos ni como apoyo', () => {
  const summary = summarizeImprovementVotes([
    { vote: 'ABSTENERSE', responseReceived: false, error: 'timeout' },
    { vote: 'ABSTENERSE', responseReceived: false, error: 'timeout' }
  ]);
  assert.equal(summary.outcome, 'SIN_VOTOS_VALIDOS');
  assert.equal(summary.answered, 0);
});

test('errores de proveedor se excluyen del recuento y no cuentan como abstenciones', () => {
  const summary = summarizeImprovementVotes([
    { vote: 'APOYAR', responseReceived: true },
    { vote: 'ABSTENERSE', responseReceived: false, error: 'timeout' },
    { vote: 'RECHAZAR', responseReceived: true },
    { vote: 'ABSTENERSE', responseReceived: false, error: 'rate limit' }
  ]);
  assert.equal(summary.outcome, 'EMPATE');
  assert.deepEqual(summary.tally, { APOYAR: 1, RECHAZAR: 1, ABSTENERSE: 0 });
  assert.equal(summary.answered, 2);
  assert.equal(summary.total, 4);
});

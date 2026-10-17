import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findReusableImprovementVote,
  parseImprovementVote,
  summarizeImprovementVotes
} from '../services/improvementVoteLogic.js';

test('parseImprovementVote accepts a canonical first line and extracts the rationale', () => {
  const parsed = parseImprovementVote(
    'VOTO: APOYAR\r\nJUSTIFICACIÓN: Reduce errores.\r\nRIESGO: Regresión.\r\nCONDICIÓN: Ejecutar pruebas.'
  );
  assert.equal(parsed.validFormat, true);
  assert.equal(parsed.vote, 'APOYAR');
  assert.match(parsed.rationale, /Reduce errores/);
});

test('parseImprovementVote rejects prose appended to the vote line', () => {
  const parsed = parseImprovementVote('VOTO: APOYAR porque parece útil\nJUSTIFICACIÓN: Sin evidencia');
  assert.equal(parsed.validFormat, false);
  assert.equal(parsed.vote, 'ABSTENERSE');
});

test('summary counts only valid provider ballots and excludes errors', () => {
  const result = summarizeImprovementVotes([
    { vote: 'APOYAR', responseReceived: true, error: null },
    { vote: 'RECHAZAR', responseReceived: true, error: null },
    { vote: 'APOYAR', responseReceived: false, error: 'timeout' },
    { vote: 'APOYAR', responseReceived: true, error: 'provider error' }
  ]);
  assert.deepEqual(result.tally, { APOYAR: 1, RECHAZAR: 1, ABSTENERSE: 0 });
  assert.equal(result.answered, 2);
  assert.equal(result.outcome, 'EMPATE');
});

test('summary reports no valid votes when every response is missing or malformed', () => {
  const result = summarizeImprovementVotes([
    { vote: 'ABSTENERSE', responseReceived: false, error: 'timeout' },
    { vote: 'ABSTENERSE', responseReceived: false, error: null }
  ]);
  assert.equal(result.outcome, 'SIN_VOTOS_VALIDOS');
  assert.equal(result.answered, 0);
});

test('reuse ignores failed votes so the same proposal can be retried', () => {
  const votes = [
    { proposal: 'Optimizar contexto', status: 'failed', id: 'failed-1' },
    { proposal: 'Optimizar contexto', status: 'failed', id: 'failed-2' }
  ];
  assert.equal(findReusableImprovementVote(votes, 'Optimizar contexto'), null);
});

test('reuse returns the newest completed or partial result case-insensitively', () => {
  const votes = [
    { proposal: 'Optimizar contexto', status: 'completed', id: 'old' },
    { proposal: 'optimizar CONTEXTO', status: 'partial', id: 'new' },
    { proposal: 'Optimizar contexto', status: 'failed', id: 'failed' }
  ];
  assert.equal(findReusableImprovementVote(votes, ' OPTIMIZAR CONTEXTO ')?.id, 'new');
});

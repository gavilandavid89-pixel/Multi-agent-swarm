import { randomUUID } from 'node:crypto';
import { consultarModelo } from './aiProviders.js';
import { getPayload, updateJob, recordTokenUsage } from './store.js';
import { parseImprovementVote, summarizeImprovementVotes } from './improvementVoteLogic.js';

const inFlightVotes = new Map();
const clip = (value, max = 1600) => String(value ?? '').slice(0, max);
const agents = [
  { name: 'Arquitecto', role: 'Valora arquitectura, alcance, compatibilidad y costos de mantenimiento.' },
  { name: 'Escéptico', role: 'Busca motivos concretos para rechazar la mejora, efectos secundarios y riesgos no evidentes.' },
  { name: 'Árbitro', role: 'Compara beneficios y riesgos; prioriza el valor para el usuario y el acuerdo del comité.' },
  { name: 'Desarrollador', role: 'Valora viabilidad, esfuerzo de implementación, pruebas necesarias y riesgo técnico.' },
  { name: 'Validador', role: 'Evalúa si la mejora puede verificarse objetivamente y si los resultados disponibles la justifican.' },
  { name: 'Coordinador de coherencia', role: 'Comprueba impacto en contratos entre módulos, dependencias y consistencia del sistema.' }
];

function voteModel(agentName) {
  if (process.env.GEMINI_API_KEY) {
    return agentName === 'Validador'
      ? (process.env.GEMINI_MODEL_VALIDATION || 'gemini-3.8-flash')
      : (process.env.GEMINI_MODEL_CODING || 'gemini-3.8-flash');
  }
  return agentName === 'Validador'
    ? (process.env.GROQ_MODEL_VALIDATION || 'openai/gpt-oss-20b')
    : (process.env.GROQ_MODEL_REASONING || 'openai/gpt-oss-20b');
}

function buildContext(payload, requestedProposal) {
  const validation = payload.validation || {};
  const findings = Array.isArray(validation.findings) ? validation.findings.slice(0, 8).map(item => clip(item, 240)).join('\n- ') : '';
  return [
    'OBJETIVO ORIGINAL:',
    clip(payload.objective, 850),
    'RESULTADO / ESTRATEGIA COMPARTIDA:',
    clip(payload.strategy || payload.result?.summary || '', 850),
    'RESULTADO DE VALIDACIÓN:',
    clip(validation.summary || 'No hay resumen de validación guardado.', 450),
    findings ? 'HALLAZGOS:\n- ' + findings : '',
    'RESUMEN DE ENTREGA:',
    clip(payload.delivery, 900),
    'MEJORA SOMETIDA A VOTACIÓN:',
    requestedProposal
  ].filter(Boolean).join('\n\n');
}

async function executeVote(jobId, proposal) {
  const record = await getPayload(jobId);
  if (!record) throw Object.assign(new Error('No existe esa tarea.'), { status: 404 });
  const job = record.publicJob;
  const budgetPaused = job.status === 'needs_review' && /presupuesto|tokens/i.test(job.stage || '');
  if (!['completed', 'needs_review'].includes(job.status) || budgetPaused) {
    throw Object.assign(new Error('La votación está disponible cuando la tarea terminó o quedó pendiente de revisión humana, no durante una ejecución o pausa de presupuesto.'), { status: 409 });
  }

  const priorVotes = Array.isArray(record.payload.improvementVotes) ? record.payload.improvementVotes : [];
  const existing = [...priorVotes].reverse().find(item =>
    String(item.proposal || '').trim().toLocaleLowerCase() === proposal.toLocaleLowerCase() &&
    ['completed', 'partial'].includes(item.status)
  );
  if (existing) return { vote: existing, reused: true };

  const context = buildContext(record.payload, proposal);
  const ballots = [];
  for (const agent of agents) {
    try {
      const onRetry = async info => {
        if (info?.usage) {
          const accounted = await recordTokenUsage(jobId, {
            ...info,
            agent: agent.name,
            stage: 'Votación de mejora',
            interaction: 'improvement-vote'
          });
          console.info('[worker][improvement_vote_usage]', JSON.stringify({
            jobId, agent: agent.name, duplicateIgnored: Boolean(accounted.duplicate),
            totalTokens: info.totalTokens || 0
          }));
        } else if (info?.reason) {
          console.warn('[worker][improvement_vote_retry]', JSON.stringify({
            jobId, agent: agent.name, retry: info.retry || null,
            waitMs: info.wait || null, reason: clip(info.reason, 180)
          }));
        }
      };
      const response = await consultarModelo({
        model: voteModel(agent.name),
        providerSlot: agent.name === 'Desarrollador' ? 'coding' : agent.name === 'Validador' ? 'validation' : 'reasoning',
        temperature: 0.1,
        maxTokens: 320,
        onRetry,
        messages: [
          {
            role: 'system',
            content: 'Sos ' + agent.name + ' en una votación técnica independiente del comité Swarm. Tu rol: ' + agent.role + ' Respondé en español, brevemente y basándote solo en el contexto proporcionado. No afirmes que implementaste ni probaste cambios. La decisión NO se aplica automáticamente. Primera línea obligatoria: VOTO: APOYAR, VOTO: RECHAZAR o VOTO: ABSTENERSE. Luego: JUSTIFICACIÓN: una razón concreta. RIESGO PRINCIPAL: un riesgo o "Ninguno identificado". CONDICIÓN: qué habría que comprobar antes de aprobar.'
          },
          { role: 'user', content: context }
        ]
      });
      const parsed = parseImprovementVote(response);
      ballots.push({
        agent: agent.name,
        vote: parsed.vote,
        rationale: parsed.rationale,
        details: clip(response, 2400),
        responseReceived: parsed.validFormat,
        error: null
      });
    } catch (error) {
      ballots.push({
        agent: agent.name,
        vote: 'ABSTENERSE',
        rationale: 'No se pudo obtener un voto por un error del proveedor. No se debe interpretar como apoyo ni rechazo.',
        details: '',
        responseReceived: false,
        error: clip(error?.message || error, 350)
      });
      console.warn('[worker][improvement_vote_agent_error]', JSON.stringify({
        jobId, agent: agent.name, code: error?.code || null,
        message: clip(error?.message || error, 250)
      }));
    }
  }

  const summary = summarizeImprovementVotes(ballots);
  const completedAt = new Date().toISOString();
  const voteRecord = {
    id: randomUUID(),
    proposal,
    status: summary.answered === ballots.length ? 'completed' : summary.answered > 0 ? 'partial' : 'failed',
    createdAt: completedAt,
    completedAt,
    votes: ballots,
    ...summary
  };
  const fresh = await getPayload(jobId);
  if (!fresh) throw Object.assign(new Error('La tarea dejó de existir durante la votación.'), { status: 404 });
  const transcript = [
    ...(Array.isArray(fresh.payload.transcript) ? fresh.payload.transcript : []),
    {
      at: completedAt,
      agent: 'sistema',
      type: 'vote',
      content: 'Votación de mejora: "' + clip(proposal, 260) + '". Resultado: ' + summary.outcome + '. A favor: ' + summary.tally.APOYAR + '; en contra: ' + summary.tally.RECHAZAR + '; abstenciones: ' + summary.tally.ABSTENERSE + '. ' + summary.summary
    },
    ...ballots.map(ballot => ({
      at: completedAt,
      agent: ballot.agent,
      type: 'vote',
      content: 'VOTO: ' + ballot.vote + '\n' + ballot.rationale + (ballot.error ? '\nError del proveedor: ' + ballot.error : '')
    }))
  ].slice(-150);
  const history = [...(Array.isArray(fresh.payload.improvementVotes) ? fresh.payload.improvementVotes : []), voteRecord].slice(-10);
  await updateJob(jobId, {
    payload: { improvementVotes: history, transcript }
  });
  console.info('[worker][improvement_vote_completed]', JSON.stringify({
    jobId, voteId: voteRecord.id, outcome: voteRecord.outcome,
    tally: voteRecord.tally, answered: voteRecord.answered, total: voteRecord.total
  }));
  return { vote: voteRecord, reused: false };
}

export async function voteOnImprovement(jobId, requestedProposal) {
  const proposal = String(requestedProposal || '').trim();
  if (!proposal) throw Object.assign(new Error('Escribí una mejora concreta para someterla a votación.'), { status: 400 });
  if (proposal.length > 1800) throw Object.assign(new Error('La propuesta supera los 1.800 caracteres.'), { status: 413 });
  const normalized = proposal.toLocaleLowerCase();
  const current = inFlightVotes.get(jobId);
  if (current) {
    if (current.proposal === normalized) return current.promise;
    throw Object.assign(new Error('Ya hay una votación en curso para esta tarea. Esperá a que termine antes de iniciar otra.'), { status: 409 });
  }
  const promise = executeVote(jobId, proposal);
  inFlightVotes.set(jobId, { proposal: normalized, promise });
  try {
    return await promise;
  } finally {
    if (inFlightVotes.get(jobId)?.promise === promise) inFlightVotes.delete(jobId);
  }
}

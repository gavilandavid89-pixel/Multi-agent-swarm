import { randomUUID } from 'node:crypto';
import { consultarModelo } from './aiProviders.js';
import { getPayload, updateJob, recordTokenUsage, listJobs } from './store.js';
import { findReusableImprovementVote, parseImprovementVote, summarizeImprovementVotes } from './improvementVoteLogic.js';

const inFlightVotes = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
  const decisions = Array.isArray(payload.committeeDecisions) ? payload.committeeDecisions.slice(-6).map(item =>
    '- ' + clip(item.proposal, 220) + ' | resultado: ' + clip(item.outcome, 80) + ' | motivo: ' + clip(item.rationale || item.summary, 260) + ' | aplicada automáticamente: no'
  ).join('\n') : '';
  const priorVotes = Array.isArray(payload.improvementVotes) ? payload.improvementVotes.filter(item => ['completed', 'partial'].includes(item.status)).slice(-3).map(item =>
    '- ' + clip(item.proposal, 180) + ' => ' + clip(item.outcome, 60) + ' (' + clip(item.summary, 220) + ')'
  ).join('\n') : '';
  return [
    'REGLA DE PRIORIDAD: el objetivo original y los requisitos explícitos del usuario son la fuente de verdad. Una propuesta del comité no puede reemplazarlos ni contradecirlos.',
    'OBJETIVO ORIGINAL:',
    clip(payload.objective, 850),
    decisions ? 'DECISIONES PREVIAS DEL COMITÉ (consultivas; no implican cambios aplicados):\n' + decisions : '',
    priorVotes ? 'VOTACIONES RECIENTES:\n' + priorVotes : '',
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


function raceDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('Se agotó el minuto de deliberación.'), { code: 'DEBATE_DEADLINE' })), Math.max(1, ms));
    timer.unref?.();
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

async function persistVoteProgress(jobId, voteId, ballots, deadlineAt) {
  const fresh = await getPayload(jobId);
  if (!fresh) return;
  const history = Array.isArray(fresh.payload.improvementVotes) ? fresh.payload.improvementVotes : [];
  const index = history.findIndex(item => item.id === voteId);
  if (index < 0) return;
  const tally = summarizeImprovementVotes(ballots);
  const updated = { ...history[index], votes: ballots.slice(), tally: tally.tally, answered: tally.answered, total: agents.length - 1, deadlineAt, summary: 'Deliberación en curso: ' + ballots.length + '/' + (agents.length - 1) + ' especialistas respondieron. El objetivo original sigue siendo prioritario.' };
  const nextHistory = history.map((item, i) => i === index ? updated : item).slice(-10);
  await updateJob(jobId, { payload: { improvementVotes: nextHistory } });
}

async function executeVote(jobId, proposal, voteId) {
  const record = await getPayload(jobId);
  if (!record) throw Object.assign(new Error('No existe esa tarea.'), { status: 404 });
  const priorVotes = Array.isArray(record.payload.improvementVotes) ? record.payload.improvementVotes : [];
  const existing = findReusableImprovementVote(priorVotes, proposal);
  if (existing) return { vote: existing, reused: true };

  const context = buildContext(record.payload, proposal);
  const ballots = [];
  const currentVote = priorVotes.find(item => item.id === voteId) || {};
  const deadlineAt = currentVote.deadlineAt || new Date(Date.now() + 60000).toISOString();
  const deadlineMs = Date.parse(deadlineAt);
  const panelists = agents.filter(agent => agent.name !== 'Árbitro');
  const panelDeadlineMs = Math.min(deadlineMs - 20000, Date.now() + 38000);

  async function askAgent(agent, deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw Object.assign(new Error('Se cerró la ventana de respuestas del panel.'), { code: 'DEBATE_PANEL_CUTOFF' });
    const onRetry = async info => {
      if (info?.usage) {
        const accounted = await recordTokenUsage(jobId, {
          ...info, agent: agent.name, stage: 'Votación de mejora', interaction: 'improvement-vote'
        });
        console.info('[worker][improvement_vote_usage]', JSON.stringify({
          jobId, agent: agent.name, duplicateIgnored: Boolean(accounted.duplicate), totalTokens: info.totalTokens || 0
        }));
      } else if (info?.reason) {
        console.warn('[worker][improvement_vote_retry]', JSON.stringify({
          jobId, agent: agent.name, retry: info.retry || null, waitMs: info.wait || null, reason: clip(info.reason, 180)
        }));
      }
    };
    const response = await raceDeadline(consultarModelo({
      model: voteModel(agent.name), temperature: 0.1, maxTokens: 220, onRetry,
      messages: [
        { role: 'system', content: 'Sos ' + agent.name + ' en una votación técnica independiente del comité Swarm. Tu rol: ' + agent.role + ' Respondé en español y en máximo 70 palabras, usando solo el contexto dado. No repitas el objetivo ni resumas toda la propuesta. No afirmes que implementaste ni probaste cambios. La decisión no se aplica automáticamente. Usá cuatro líneas exactas: VOTO: APOYAR o RECHAZAR o ABSTENERSE; JUSTIFICACIÓN: razón concreta; RIESGO: principal riesgo; CONDICIÓN: comprobación previa. La primera línea debe contener únicamente el voto.' },
        { role: 'user', content: context }
      ]
    }), remainingMs);
    const parsed = parseImprovementVote(response);
    return {
      at: new Date().toISOString(), agent: agent.name, vote: parsed.vote,
      rationale: parsed.rationale, details: clip(response, 900),
      responseReceived: parsed.validFormat, error: null
    };
  }

  // Los cinco especialistas responden en paralelo. Se cierra la recepción en el segundo 40
  // para reservar una ventana independiente al Árbitro y margen para persistir el resultado.
  let acceptingPanel = true;
  // Serializa las escrituras: las cinco respuestas pueden llegar casi simultáneamente y
  // una lectura/escritura concurrente del payload podría sobrescribir votos recién guardados.
  let persistChain = Promise.resolve();
  const persistBallots = () => {
    persistChain = persistChain.then(() => persistVoteProgress(jobId, voteId, ballots, deadlineAt));
    return persistChain;
  };
  const pending = panelists.map(agent => askAgent(agent, panelDeadlineMs).then(async ballot => {
    if (!acceptingPanel) return null;
    ballots.push(ballot);
    await persistBallots();
    return ballot;
  }).catch(async error => {
    if (!acceptingPanel) return null;
    ballots.push({
      at: new Date().toISOString(), agent: agent.name, vote: 'ABSTENERSE',
      rationale: 'No se obtuvo una respuesta válida dentro de la ventana del panel; no equivale a apoyo ni rechazo.',
      details: '', responseReceived: false, error: clip(error?.message || error, 240)
    });
    await persistBallots().catch(() => {});
    console.warn('[worker][improvement_vote_agent_error]', JSON.stringify({
      jobId, agent: agent.name, code: error?.code || null, message: clip(error?.message || error, 180)
    }));
    return null;
  }));
  await Promise.race([
    Promise.allSettled(pending),
    sleep(Math.max(0, panelDeadlineMs - Date.now()))
  ]);
  acceptingPanel = false;
  await Promise.allSettled(pending);

  // Evita que una respuesta tardía cambie el resultado después de cerrar el panel.
  const panelSnapshot = ballots.slice();
  const panelSummary = summarizeImprovementVotes(panelSnapshot);
  let arbiterNote = 'Árbitro: no hubo tiempo suficiente para sintetizar las respuestas.';
  const arbiter = agents.find(agent => agent.name === 'Árbitro');
  const arbiterStart = deadlineMs - 20000;
  const arbiterDeadline = deadlineMs - 10000;
  const arbiterInput = [
    'Objetivo original (prioritario): ' + clip(record.payload.objective, 500),
    'Mejora evaluada: ' + clip(proposal, 500),
    'Votos recibidos:',
    ...panelSnapshot.map(item => '- ' + item.agent + ': ' + item.vote + '; ' + clip(item.rationale, 180) + (item.error ? ' [sin respuesta válida]' : '')),
    'Conteo provisional: ' + JSON.stringify(panelSummary.tally),
    'Decidí brevemente qué riesgos o condiciones deben gobernar la decisión. No inventes evidencia, no cambies el objetivo original y no interpretes abstenciones como apoyo.'
  ].join('\n');
  if (Date.now() < arbiterStart) await sleep(arbiterStart - Date.now());
  if (Date.now() < arbiterDeadline) {
    try {
      arbiterNote = 'Síntesis del Árbitro: ' + clip(await raceDeadline(consultarModelo({
        model: voteModel(arbiter.name), temperature: 0.1, maxTokens: 180,
        onRetry: async info => {
          if (info?.usage) {
            const accounted = await recordTokenUsage(jobId, { ...info, agent: arbiter.name, stage: 'Síntesis del comité', interaction: 'improvement-vote' });
            console.info('[worker][improvement_vote_usage]', JSON.stringify({ jobId, agent: arbiter.name, duplicateIgnored: Boolean(accounted.duplicate), totalTokens: info.totalTokens || 0 }));
          }
        },
        messages: [
          { role: 'system', content: 'Sos el Árbitro técnico del comité Swarm. Sintetizá los votos recibidos en máximo 55 palabras. Indicá desacuerdos, riesgo principal y condición verificable. No vuelvas a votar ni afirmes que el cambio se aplicó.' },
          { role: 'user', content: arbiterInput }
        ]
      }), Math.max(1, arbiterDeadline - Date.now())), 1100);
    } catch (error) {
      arbiterNote = 'Árbitro: no se obtuvo síntesis antes del límite; se conservan los votos parciales. ' + clip(error?.message || error, 160);
    }
  }

  const summary = summarizeImprovementVotes(panelSnapshot);
  const completedAt = new Date().toISOString();
  const voteRecord = {
    id: voteId, proposal, kind: 'vote',
    status: summary.answered >= panelists.length ? 'completed' : summary.answered > 0 ? 'partial' : 'failed',
    createdAt: currentVote.createdAt || completedAt, completedAt, deadlineAt,
    votes: panelSnapshot, ...summary, total: panelists.length,
    arbiterSummary: arbiterNote,
    summary: clip(summary.summary + ' ' + arbiterNote, 1600)
  };
  const fresh = await getPayload(jobId);
  if (!fresh) throw Object.assign(new Error('La tarea dejó de existir durante la votación.'), { status: 404 });
  const previousHistory = Array.isArray(fresh.payload.improvementVotes) ? fresh.payload.improvementVotes : [];
  const existingIndex = previousHistory.findIndex(item => item.id === voteId);
  const history = existingIndex >= 0
    ? previousHistory.map(item => item.id === voteId ? voteRecord : item).slice(-10)
    : [...previousHistory, voteRecord].slice(-10);
  const previousDecisions = Array.isArray(fresh.payload.committeeDecisions) ? fresh.payload.committeeDecisions : [];
  const decision = {
    id: voteId, kind: 'vote', proposal, outcome: voteRecord.outcome,
    rationale: voteRecord.summary, status: voteRecord.status, createdAt: completedAt,
    applied: false, requiresHumanReview: true
  };
  await updateJob(jobId, {
    payload: { improvementVotes: history, committeeDecisions: [...previousDecisions, decision].slice(-20) }
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
    if (current.proposal === normalized) return { vote: current.record, reused: true, started: true };
    throw Object.assign(new Error('Ya hay una votación en curso para esta tarea. El motor puede estar esperando en un checkpoint seguro; esperá a que termine antes de iniciar otra.'), { status: 409 });
  }
  const record = await getPayload(jobId);
  if (!record) throw Object.assign(new Error('No existe esa tarea.'), { status: 404 });
  const budgetPaused = record.publicJob.status === 'needs_review' && /presupuesto|tokens/i.test(record.publicJob.stage || '');
  if (budgetPaused) throw Object.assign(new Error('La tarea está pausada por presupuesto. Ampliá el presupuesto o reanudá la tarea antes de convocar la votación.'), { status: 409 });
  const priorVotes = Array.isArray(record.payload.improvementVotes) ? record.payload.improvementVotes : [];
  const existing = findReusableImprovementVote(priorVotes, normalized);
  if (existing) return { vote: existing, reused: true, started: false };
  const voteId = randomUUID();
  const runningRecord = {
    id: voteId, proposal, kind: 'vote', status: 'running', createdAt: new Date().toISOString(), completedAt: null,
    deadlineAt: new Date(Date.now() + 60000).toISOString(), votes: [],
    tally: { APOYAR: 0, RECHAZAR: 0, ABSTENERSE: 0 }, outcome: 'EN_CURSO',
    summary: 'Deliberación de hasta 60 segundos. Si la tarea está activa, el motor espera en el próximo checkpoint seguro; no se aplican cambios automáticamente.', answered: 0, total: agents.length - 1
  };
  await updateJob(jobId, { payload: { improvementVotes: [...priorVotes, runningRecord].slice(-10) } });
  let promise;
  promise = executeVote(jobId, proposal, voteId)
    .catch(async error => {
      console.error('[worker][improvement_vote_failed]', JSON.stringify({ jobId, voteId, message: clip(error?.message || error, 250) }));
      const fresh = await getPayload(jobId).catch(() => null);
      if (fresh) {
        const history = Array.isArray(fresh.payload.improvementVotes) ? fresh.payload.improvementVotes : [];
        await updateJob(jobId, { payload: { improvementVotes: history.map(item => item.id === voteId ? {
          ...item, status: 'failed', outcome: 'SIN_VOTOS_VALIDOS', summary: 'La votación no pudo completarse: ' + clip(error?.message || error, 220),
          completedAt: new Date().toISOString()
        } : item) } }).catch(() => {});
      }
    })
    .finally(() => { if (inFlightVotes.get(jobId)?.promise === promise) inFlightVotes.delete(jobId); });
  inFlightVotes.set(jobId, { proposal: normalized, promise, record: runningRecord });
  return { vote: runningRecord, reused: false, started: true };
}

export async function recoverInterruptedVotes() {
  let offset = 0;
  let recovered = 0;
  while (true) {
    const page = await listJobs({ limit: 100, offset });
    for (const job of page.jobs || []) {
      const record = await getPayload(job.id).catch(() => null);
      if (!record) continue;
      const votes = Array.isArray(record.payload.improvementVotes) ? record.payload.improvementVotes : [];
      const expired = votes.filter(item => item.status === 'running');
      if (!expired.length) continue;
      const now = new Date().toISOString();
      const nextVotes = votes.map(item => {
        if (!expired.some(candidate => candidate.id === item.id)) return item;
        const summary = summarizeImprovementVotes(Array.isArray(item.votes) ? item.votes : []);
        const answered = Number(summary.answered) || 0;
        return {
          ...item,
          status: answered > 0 ? 'partial' : 'failed',
          outcome: summary.outcome,
          completedAt: now,
          summary: 'La deliberación quedó interrumpida por un reinicio del Worker. ' + summary.summary + ' Se conserva el progreso guardado; revisá las respuestas antes de decidir.'
        };
      });
      const expiredIds = new Set(expired.map(item => item.id));
      const oldTranscript = Array.isArray(record.payload.transcript) ? record.payload.transcript : [];
      const notices = expired.map(item => ({
        at: now, agent: 'sistema', type: 'vote',
        voteId: item.id,
        content: 'Deliberación recuperada tras reinicio. La votación se cerró con las respuestas guardadas; no se aplicó ningún cambio automáticamente.'
      }));
      await updateJob(job.id, { payload: { improvementVotes: nextVotes, transcript: [...oldTranscript, ...notices].slice(-150), committeePause: null } });
      recovered += expired.length;
    }
    offset += (page.jobs || []).length;
    if (!page.hasMore || !(page.jobs || []).length) break;
  }
  if (recovered) console.info('[worker][improvement_vote_recovered]', JSON.stringify({ recovered }));
  return recovered;
}

import { agenteArquitecto, agenteEsceptico, agenteArbitro, agenteCoordinador, agenteAuditorCoherencia, agenteDesarrollador, agenteValidador } from './aiProviders.js';
import { getPayload, updateJob, saveArtifacts, recordTokenUsage, withJobLock, createContinuationJob } from './store.js';
import { checkJavascriptSyntax, extractFiles } from './codeChecks.js';
import { runAgentCommand, runProjectToolchainChecks, getAgentJobStatus, cancelAgentJob, getAgentJobArtifact } from './runnerClient.js';
import { deriveAgentWorkspaceId } from './agentWorkspace.js';
import { AGENT_TOOL_DEFINITIONS, createAgentToolDispatcher } from './agentToolDispatcher.js';
import { getValidationResumeState } from './validationResume.js';
import { buildBudgetPausePatch } from './tokenAccounting.js';
import { getDeferredCooldownMs, getScheduledJobDelayMs } from './providerRetryPolicy.js';
import { recordAgentCheckpoint } from './agentMemory.js';
// Entrega inicial y hasta dos ciclos correctivos; cada ronda pasa por auditoría y validación.
const MAX_ROUNDS = 3; // hasta dos ciclos correctivos, además de la entrega inicial
const MAX_TRANSCRIPT_ENTRIES = 150;
async function createDeveloperToolContext(jobId, round, seedDelivery = '') {
  const workspaceId = deriveAgentWorkspaceId(jobId, 'desarrollador', 'round-' + round);
  const initial = await getPayload(jobId);
  const stored = initial?.payload?.agentWorkspaces?.[workspaceId];
  if (!Array.isArray(stored)) {
    const seed = extractFiles(seedDelivery);
    if (seed.length) await updateJob(jobId, { payload: { agentWorkspaces: { ...(initial?.payload?.agentWorkspaces || {}), [workspaceId]: seed } } });
  }
  const readFiles = async () => {
    const record = await getPayload(jobId);
    const value = record?.payload?.agentWorkspaces?.[workspaceId];
    return Array.isArray(value) ? value.map(file => ({ path: file.path, content: file.content })) : [];
  };
  const writeFiles = async files => {
    const record = await getPayload(jobId);
    const all = record?.payload?.agentWorkspaces || {};
    await updateJob(jobId, { payload: { agentWorkspaces: { ...all, [workspaceId]: files } } });
  };
  const workspace = {
    list: readFiles,
    read: async path => (await readFiles()).find(file => file.path === path)?.content ?? null,
    write: async (path, content) => {
      const files = await readFiles();
      const next = [...files.filter(file => file.path !== path), { path, content }].sort((a, b) => a.path.localeCompare(b.path));
      await writeFiles(next);
      return { path, bytes: Buffer.byteLength(content, 'utf8') };
    }
  };
  let executionCount = 0;
  const refreshFromArtifacts = async result => {
    if (Array.isArray(result?.artifacts) && result.artifacts.length) {
      const current = await readFiles();
      const byPath = new Map(current.map(file => [file.path, file]));
      for (const file of result.artifacts) if (file && typeof file.path === 'string' && typeof file.content === 'string') byPath.set(file.path, file);
      await writeFiles([...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)));
    }
    return result;
  };
  const runner = {
    execute: async input => {
      executionCount++;
      return refreshFromArtifacts(await runAgentCommand({
        taskId: jobId, workspaceId, files: await readFiles(), command: input.command,
        network: input.network, timeoutMs: input.timeoutMs, includeArtifacts: true,
        idempotencyKey: jobId + ':agent-tool:' + workspaceId + ':' + executionCount
      }));
    },
    check: async () => runProjectToolchainChecks({ taskId: jobId, round, files: await readFiles() }),
    jobStatus: getAgentJobStatus,
    cancel: cancelAgentJob,
    artifact: getAgentJobArtifact,
    dependency: async input => {
      const commands = {
        'package-lock.json': ['npm', 'ci'],
        'requirements.txt': ['python3', '-m', 'pip', 'install', '-r', 'requirements.txt'],
        'pyproject.toml': ['python3', '-m', 'pip', 'install', '.'],
        'composer.lock': ['composer', 'install', '--no-interaction', '--prefer-dist'],
        'Gemfile.lock': ['bundle', 'install'],
        'go.sum': ['go', 'mod', 'download'],
        'Cargo.lock': ['cargo', 'fetch', '--locked'],
        'pom.xml': ['mvn', '-B', '-DskipTests', 'dependency:go-offline']
      };
      executionCount++;
      return refreshFromArtifacts(await runAgentCommand({
        taskId: jobId, workspaceId, files: await readFiles(), command: commands[input.manifest],
        network: 'restricted', timeoutMs: 120000, includeArtifacts: true,
        idempotencyKey: jobId + ':agent-dependencies:' + workspaceId + ':' + executionCount
      }));
    }
  };
  const dispatcher = createAgentToolDispatcher({ role: 'desarrollador', workspace, runner, jobId, round, maxCalls: 40 });
  return {
    workspace, workspaceId, tools: AGENT_TOOL_DEFINITIONS,
    onToolCall: ({ name, arguments: args }) => dispatcher.invoke({ name, arguments: args })
  };
}
function workspaceFilesAsDelivery(files) {
  return (Array.isArray(files) ? files : []).map(file => {
    const ext = String(file.path || '').split('.').pop().toLowerCase();
    const lang = ({ js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', py: 'python', html: 'html', css: 'css', json: 'json', yml: 'yaml', yaml: 'yaml', md: 'markdown', sh: 'bash' })[ext] || '';
    return '### Archivo: ' + file.path + '\n\n' + String.fromCharCode(96, 96, 96) + lang + '\n' + file.content + '\n' + String.fromCharCode(96, 96, 96);
  }).join('\n\n');
}

function appendEntries(existing, entries) { return [...(Array.isArray(existing) ? existing : []), ...entries].slice(-MAX_TRANSCRIPT_ENTRIES); }
function selectRepairContext(delivery, findings) {
  const source = String(delivery || '');
  const parts = source.split(/(?=^#{1,6}\s+(?:Archivo|File|Ruta)\s*:)/gim).filter(part => part.trim());
  const names = String(findings || '').match(/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:js|mjs|cjs|css|html?|json|webmanifest|ts|tsx|jsx|md)/g) || [];
  const selected = parts.filter(part => names.some(name => part.split('\n', 1)[0].includes(name)));
  return selected.length ? selected.join('\n\n') : source;
}
function mergeDelivery(previous, correction) {
  const split = value => {
    const source = String(value || '');
    const parts = source.split(/(?=^#{1,6}\s+(?:Archivo|File|Ruta)\s*:)/gim).filter(part => part.trim());
    const files = new Map(); let preamble = '';
    for (const part of parts) {
      const firstLine = part.split('\n', 1)[0].trim();
      const match = firstLine.match(/^#{1,6}\s+(?:Archivo|File|Ruta)\s*:\s*(.+)$/i);
      if (match) files.set(match[1].trim().replace(/[\x60"]/g, ''), part.trim());
      else if (!preamble) preamble = part.trim();
    }
    return { preamble, files };
  };
  const base = split(previous); const patch = split(correction);
  if (!patch.files.size) return String(correction || previous || '');
  for (const [name, body] of patch.files) base.files.set(name, body);
  return [base.preamble || patch.preamble, ...base.files.values()].filter(Boolean).join('\n\n');
}
async function retryNotice(jobId, info) {
  const current = await getPayload(jobId); if (!current) return;
  if (info.usage) {
    const accounted = await recordTokenUsage(jobId, info);
    const model = String(info.model || 'desconocido');
    console.info('[worker][provider_usage]', JSON.stringify({
      jobId, model, agent: info.agent || 'Agente sin clasificar', stage: info.stage || 'Etapa sin clasificar',
      interaction: info.interaction || 'workflow',
      promptTokens: info.promptTokens || 0, completionTokens: info.completionTokens || 0,
      totalTokens: info.totalTokens || 0, duplicateIgnored: Boolean(accounted.duplicate),
      countedAsWaste: Boolean(accounted.event?.countedAsWaste)
    }));
    if (!accounted.duplicate) {
      const fresh = await getPayload(jobId);
      if (fresh && fresh.publicJob.status !== 'completed') {
        await updateJob(jobId, { payload: { providerFailureStreak: 0 } });
      }
    }
    return;
  }
  const reason = String(info.reason || 'error temporal').slice(0, 240);
  console.warn('[worker][provider_retry]', JSON.stringify({ jobId, retry: info.retry, waitMs: info.wait, reason }));
  const transcript = appendEntries(current.payload.transcript, [{ at: new Date().toISOString(), agent: 'sistema', type: 'retry', content: `[${info.agent || 'Agente'} · ${info.stage || 'sin etapa'}] Reintento ${info.retry}; espera ${Math.ceil(info.wait / 1000)} s; motivo: ${reason}` }]);
  await updateJob(jobId, { stage: 'Esperando al proveedor de IA', payload: { transcript, activeStage: current.payload.activeStage || null } });
}
async function getOutputAllowance(jobId, requested, estimatedInputTokens = 0) {
  const current = await getPayload(jobId);
  const rawLimit = Number.parseInt(process.env.MAX_TASK_TOKENS || '1000000', 10);
  const fallback = Number.isFinite(rawLimit) ? Math.min(1000000, Math.max(4000, rawLimit)) : 1000000;
  const limit = Math.min(1000000, Math.max(4000, Number(current?.payload?.tokenBudget) || fallback));
  const used = Number(current?.payload?.tokenUsage?.totalTokens) || 0;
  const remaining = Math.max(0, limit - used);
  const inputReserve = Math.max(0, Math.ceil(Number(estimatedInputTokens) || 0));
  const availableForOutput = Math.max(0, remaining - inputReserve);
  if (availableForOutput < 256) {
    const error = new Error(`Presupuesto insuficiente antes de llamar al modelo: ${used} usados, ${inputReserve} estimados para entrada y límite ${limit}. El checkpoint se conserva; se creará automáticamente una tarea de continuación con presupuesto propio.`);
    error.code = 'TASK_TOKEN_BUDGET'; error.usedTokens = used; error.tokenLimit = limit; error.estimatedInputTokens = inputReserve;
    throw error;
  }
  return Math.min(Math.max(256, Number(requested) || 1200), availableForOutput);
}
async function assertTaskTokenBudget(jobId) {
  const rawLimit = Number.parseInt(process.env.MAX_TASK_TOKENS || '1000000', 10);
  const defaultLimit = Number.isFinite(rawLimit) ? Math.min(1000000, Math.max(4000, rawLimit)) : 1000000;
  const current = await getPayload(jobId);
  const limit = Math.min(1000000, Math.max(4000, Number(current?.payload?.tokenBudget) || defaultLimit));
  const used = Number(current?.payload?.tokenUsage?.totalTokens) || 0;
  if (used >= limit) {
    const error = new Error(`Se alcanzó el presupuesto de la tarea (${used}/${limit} tokens). El checkpoint se conserva; se creará automáticamente una tarea de continuación con presupuesto propio.`);
    error.code = 'TASK_TOKEN_BUDGET'; error.usedTokens = used; error.tokenLimit = limit;
    throw error;
  }
}
async function startAgent(jobId, stage, progress, agent, content) {
  const current = await getPayload(jobId); if (!current) throw new Error('La tarea dejó de existir.');
  const transcript = appendEntries(current.payload.transcript, [{ at: new Date().toISOString(), agent, type: 'thinking', content }]);
  return updateJob(jobId, { status: 'running', stage, progress, error: null, payload: { transcript, retryAt: null, providerBlock: null, activeStage: stage } });
}
async function checkpoint(jobId, stage, progress, agent, content, extra = {}, publicPatch = {}) {
  const current = await getPayload(jobId); if (!current) throw new Error('La tarea dejó de existir.');
  const transcript = Array.isArray(current.payload.transcript) ? [...current.payload.transcript] : [];
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].agent === agent && transcript[i].type === 'thinking') {
      transcript.splice(i, 1);
      break;
    }
  }
  transcript.push({ at: new Date().toISOString(), agent, type: 'message', content: String(content ?? '').slice(0, 16000) });
  const checkpointPayload = { ...current.payload, ...extra };
  const memory = recordAgentCheckpoint(checkpointPayload, { agent, stage, content });
  return await updateJob(jobId, { status: 'running', stage, progress, payload: { transcript: transcript.slice(-MAX_TRANSCRIPT_ENTRIES), lastCheckpoint: stage, activeStage: null, ...extra, ...memory }, ...publicPatch });
}
export async function processJob(jobId) {
  const result = await withJobLock(jobId, () => runJob(jobId));
  if (result?.lockBusy) {
    console.info('[worker][job_lock_busy]', JSON.stringify({ jobId, retryAfterMs: 5000 }));
    return { deferred: true, retryAfterMs: 5000, duplicateExecutionPrevented: true };
  }
  return result;
}

async function runJob(jobId) {
  const initial = await getPayload(jobId); if (!initial) return; if (initial.publicJob.status === 'completed') return;
  const scheduledDelay = getScheduledJobDelayMs({ status: initial.publicJob.status, retryAt: initial.payload.retryAt });
  if (scheduledDelay > 0) {
    console.info('[worker][job_cooldown_respected]', JSON.stringify({ jobId, retryAfterMs: scheduledDelay, retryAt: initial.payload.retryAt }));
    return { deferred: true, retryAfterMs: scheduledDelay, respectingScheduledCooldown: true };
  }
  const objective = initial.payload.objective;
  const onRetry = (agent, stage) => {
    const notify = info => retryNotice(jobId, { ...info, agent, stage, interaction: 'workflow' });
    notify.getMaxOutputTokens = (requested, estimatedInputTokens) => getOutputAllowance(jobId, requested, estimatedInputTokens);
    return notify;
  };
  const initialPartialDelivery = String(initial.payload.partialDelivery || '');
  const savePartial = async info => {
    const current = await getPayload(jobId);
    if (!current || typeof info?.content !== 'string') return;
    const fresh = info.content;
    const hasFileHeaders = /^#{1,6}\s+(?:Archivo|File|Ruta)\s*:/im.test(fresh);
    const preserved = initialPartialDelivery
      ? (hasFileHeaders ? mergeDelivery(initialPartialDelivery, fresh) : `${initialPartialDelivery}\n\n${fresh}`)
      : fresh;
    await updateJob(jobId, { payload: { partialDelivery: preserved, partialOutputAt: new Date().toISOString() } });
  };
  const canContinue = async (_requested, estimatedInputTokens = 0) => { const record = await getPayload(jobId); const configured = Number.parseInt(process.env.MAX_TASK_TOKENS || '1000000', 10); const fallback = Number.isFinite(configured) ? Math.min(1000000, Math.max(4000, configured)) : 1000000; const budget = Math.min(1000000, Math.max(4000, Number(record?.payload?.tokenBudget) || fallback)); const used = Number(record?.payload?.tokenUsage?.totalTokens) || 0; return Math.max(0, budget - used - Math.max(0, Math.ceil(Number(estimatedInputTokens) || 0))); };
  let payload = initial.payload; let { proposal = '', critique = '', strategy = '', coherence = '', delivery = '', partialDelivery = '' } = payload;
  try {
    if (!proposal) {
      await startAgent(jobId, 'Arquitectura', 5, 'Arquitecto', 'Voy a ordenar el objetivo, fijar las decisiones técnicas y dejar criterios claros para que el equipo pueda comprobar el resultado.');
      await assertTaskTokenBudget(jobId);
      proposal = await agenteArquitecto(objective, onRetry('Arquitecto', 'Arquitectura'));
      await checkpoint(jobId, 'Auditoría escéptica', 15, 'Arquitecto', proposal, { proposal });
    }
    if (!critique) {
      await startAgent(jobId, 'Auditoría escéptica', 15, 'Escéptico', 'Voy a poner a prueba la propuesta: buscaré contradicciones, situaciones límite y fallos que podrían pasar inadvertidos.');
      await assertTaskTokenBudget(jobId);
      critique = await agenteEsceptico(objective, proposal, onRetry('Escéptico', 'Auditoría escéptica'));
      await checkpoint(jobId, 'Síntesis técnica', 25, 'Escéptico', critique, { proposal, critique });
    }
    if (!strategy) {
      await startAgent(jobId, 'Síntesis técnica', 25, 'Árbitro', 'Revisaré las objeciones una por una y decidiré qué controles son necesarios antes de avanzar.');
      await assertTaskTokenBudget(jobId);
      strategy = await agenteArbitro(objective, proposal, critique, onRetry('Árbitro', 'Síntesis técnica'));
      await checkpoint(jobId, 'Desarrollo', 35, 'Árbitro', strategy, { proposal, critique, strategy });
    }
    if (!coherence) {
      await startAgent(jobId, 'Mapa de coherencia', 30, 'Coordinador de coherencia', 'Voy a comprobar cómo encajan las partes, qué información se pasan entre sí y qué acuerdos necesita respetar el equipo.');
      await assertTaskTokenBudget(jobId);
      coherence = await agenteCoordinador(objective, strategy, proposal, critique, onRetry('Coordinador de coherencia', 'Mapa de coherencia'));
      await checkpoint(jobId, 'Mapa de coherencia', 32, 'Coordinador de coherencia', coherence, { proposal, critique, strategy, coherence });
    }
    if (!delivery) {
      await startAgent(jobId, 'Desarrollo', 35, 'Desarrollador', 'Con el plan acordado, voy a construir los archivos procurando que las piezas encajen entre sí; después pasarán una revisión independiente.');
      await assertTaskTokenBudget(jobId);
      const toolContext = await createDeveloperToolContext(jobId, 1, partialDelivery || delivery);
      if (partialDelivery) {
        delivery = partialDelivery;
        const continuation = await agenteDesarrollador(objective, strategy, 'CONTINUÁ LA ENTREGA TRUNCADA. El contenido previo quedó cortado por el límite de salida. Terminá el archivo incompleto y entregá completos los archivos afectados, sin repetir el contenido anterior como explicación.', onRetry('Desarrollador', 'Desarrollo'), partialDelivery, coherence, canContinue, savePartial, toolContext);
        delivery = mergeDelivery(partialDelivery, continuation);
      } else {
        delivery = await agenteDesarrollador(objective, strategy, '', onRetry('Desarrollador', 'Desarrollo'), '', coherence, canContinue, savePartial, toolContext);
      }
      const workspaceDelivery = workspaceFilesAsDelivery(await toolContext.workspace.list());
      if (workspaceDelivery) delivery = mergeDelivery(delivery, workspaceDelivery);
      await checkpoint(jobId, 'Validación', 55, 'Desarrollador', delivery, { proposal, critique, strategy, coherence, delivery, partialDelivery: '', partialOutputAt: null });
      await saveArtifacts(jobId, delivery);
    }
    payload = (await getPayload(jobId))?.payload || {};
    let validation = payload.validation || null; let syntax = payload.syntax || null;
    let resumeState = getValidationResumeState(payload, (await getPayload(jobId))?.publicJob.attempt || 0);
    let round = resumeState.round;
    while (round <= MAX_ROUNDS) {
      const saved = resumeState.validationSaved;
      const progress = Math.min(60 + Math.round((round - 1) * 30 / MAX_ROUNDS), 90);
      if (!saved) {
        let coherenceReview = resumeState.coherenceReview;
        if (!coherenceReview) {
          await startAgent(jobId, `Auditoría de coherencia ${round}/${MAX_ROUNDS}`, progress, 'Coordinador de coherencia', 'Voy a revisar las conexiones entre archivos y buscar incompatibilidades concretas antes de que el proyecto llegue a la validación final.');
          await assertTaskTokenBudget(jobId);
          coherenceReview = await agenteAuditorCoherencia(objective, coherence, delivery, onRetry('Coordinador de coherencia', `Auditoría de coherencia ${round}`));
          await checkpoint(jobId, `Auditoría de coherencia ${round}`, progress + 2, 'Coordinador de coherencia', JSON.stringify(coherenceReview), { proposal, critique, strategy, coherence, coherenceReview, coherenceReviewRound: round, activeValidationRound: round, delivery, validation: null, syntax: null });
        }
        await startAgent(jobId, `Validación ${round}/${MAX_ROUNDS}`, progress + 2, 'Validador', 'Haré una revisión independiente y separaré los problemas confirmados de las dudas que todavía requieren comprobación.');
        await assertTaskTokenBudget(jobId);
        validation = await agenteValidador(objective, strategy, delivery, onRetry('Validador', `Validación ${round}`));
        if (coherenceReview.verdict !== 'APPROVED') {
          validation = {
            ...validation,
            verdict: 'NEEDS_CHANGES',
            findings: [...(coherenceReview.findings || []).map(finding => 'Coherencia entre archivos: ' + finding), ...(validation.findings || [])].slice(0, 30),
            summary: 'El coordinador detectó posibles incompatibilidades entre archivos. ' + String(validation.summary || '').slice(0, 3500)
          };
        }
        syntax = await checkJavascriptSyntax(delivery);
        const runnerExecution = await runProjectToolchainChecks({ taskId: jobId, round, files: extractFiles(delivery) });
        const hasRuntimeTests = Array.isArray(runnerExecution.runtimeChecks)
          && runnerExecution.runtimeChecks.some(item => item.phase === 'tests');
        const executionStatus = hasRuntimeTests
          ? (runnerExecution.ok ? 'APROBADO' : 'FALLO')
          : runnerExecution.checked && !runnerExecution.ok ? 'FALLO'
            : runnerExecution.checked ? 'SOLO ESTÁTICO'
            : runnerExecution.skipped ? 'NO EJECUTADO' : 'NO DISPONIBLE';
        syntax = {
          ...syntax,
          runnerExecution,
          executionStatus,
          ok: Boolean(syntax.ok && runnerExecution.ok),
          message: [syntax.message, 'Runner aislado (' + executionStatus + '): ' + String(runnerExecution.message || (runnerExecution.ok ? 'sin comprobación de ejecución' : 'falló la ejecución')).slice(0, 2500)].filter(Boolean).join('\n')
        };
        const current = await getPayload(jobId); if (!current) throw new Error('La tarea dejó de existir durante la validación.');
        const transcript = Array.isArray(current.payload.transcript) ? [...current.payload.transcript] : [];
        for (let i = transcript.length - 1; i >= 0; i--) {
          if (transcript[i].agent === 'Validador' && transcript[i].type === 'thinking') {
            transcript.splice(i, 1);
            break;
          }
        }
        transcript.push(
          { at: new Date().toISOString(), agent: 'Validador', type: 'message', content: JSON.stringify(validation).slice(0, 20000) },
          { at: new Date().toISOString(), agent: 'Validador determinista', type: 'check', content: syntax.message.slice(0, 4000) }
        );
        await updateJob(jobId, { status: 'running', stage: `Validación ${round}/${MAX_ROUNDS}`, progress: progress + 5, attempt: round, payload: { transcript: transcript.slice(-MAX_TRANSCRIPT_ENTRIES), proposal, critique, strategy, coherenceReview: coherenceReview || null, coherenceReviewRound: round, activeValidationRound: round, delivery, validation, syntax, validationRound: round, lastCheckpoint: `validation-${round}` } });
        payload = (await getPayload(jobId))?.payload || {};
        resumeState = getValidationResumeState(payload, round);
      }
      if (syntax?.runnerExecution?.infraError) {
        const latest = await getPayload(jobId);
        if (latest) {
          const transcript = appendEntries(latest.payload.transcript, [{
            at: new Date().toISOString(), agent: 'sistema', type: 'error',
            content: 'La ejecución aislada no estuvo disponible o falló por infraestructura. No se atribuye el fallo al código ni se consumen rondas correctivas; se conserva el checkpoint para reintentar cuando el runner esté operativo.'
          }]);
          await updateJob(jobId, {
            status: 'needs_review', stage: 'Runner no disponible · requiere revisión', progress: 99,
            error: 'No se pudo confirmar la ejecución aislada por un problema de infraestructura. Revisá la conexión del runner y reintentá.',
            payload: { ...latest.payload, transcript, syntax, validation, delivery, activeStage: null, lastCheckpoint: 'runner-infra-error', result: { status: 'needs_review', delivery, validation, syntax } }
          });
        }
        return { blocked: true, reason: 'runner-infra-error' };
      }
      if (validation?.verdict === 'APPROVED' && syntax?.ok) {
        const runtimeTestsExecuted = Array.isArray(syntax.runnerExecution?.runtimeChecks)
          && syntax.runnerExecution.runtimeChecks.some(item => item.phase === 'tests');
        const validationLevel = runtimeTestsExecuted
          ? 'ai_syntax_and_runtime'
          : syntax.checked ? 'ai_and_syntax' : 'ai_review_only';
        const validationDescription = runtimeTestsExecuted
          ? 'revisión de IA, sintaxis y pruebas ejecutadas'
          : syntax.checked ? 'revisión de IA y sintaxis; pruebas de proyecto no confirmadas' : 'revisión de IA';
        const result = { status: 'completed', validationLevel, executionStatus: syntax.executionStatus || 'NO EJECUTADO', summary: validation.summary, delivery, validation, syntax };
        const latestPayload = (await getPayload(jobId))?.payload || {};
        const transcript = appendEntries(latestPayload.transcript, [{
          at: new Date().toISOString(), agent: 'sistema', type: 'check',
          content: `El comité terminó la tarea y la validación final fue aprobada (${validationDescription}). El resultado está listo para revisar.`
        }]);
        await updateJob(jobId, { status: 'completed', stage: runtimeTestsExecuted ? 'Completado · IA + sintaxis + ejecución' : syntax.checked ? 'Completado · IA + sintaxis' : 'Completado · revisión IA', progress: 100, attempt: round, error: null, payload: { proposal, critique, strategy, coherence, coherenceReview: latestPayload.coherenceReview || null, delivery, validation, syntax, validationRound: round, validationLevel, result, transcript, activeStage: null, lastCheckpoint: 'completed' } });
        return;
      }
      if (round >= MAX_ROUNDS) break;
      const findings = [...(validation?.findings || [])]; if (syntax && !syntax.ok) findings.push(syntax.message);
      if (!findings.length) findings.push('La revisión no aprobó la entrega; explicá y corregí los puntos débiles.');
      await startAgent(jobId, `Corrección ${round}`, Math.min(progress + 5, 94), 'Desarrollador (corrección)', 'Estoy corrigiendo los hallazgos de la revisión antes de volver a validar.');
      await assertTaskTokenBudget(jobId);
      const repairContext = selectRepairContext(delivery, findings.join('\n'));
      const toolContext = await createDeveloperToolContext(jobId, round + 1, repairContext);
      const correctedOutput = await agenteDesarrollador(objective, strategy, findings.join('\n'), onRetry('Desarrollador (corrección)', `Corrección ${round}`), repairContext, coherence, canContinue, savePartial, toolContext);
      const workspaceDelivery = workspaceFilesAsDelivery(await toolContext.workspace.list());
      const correctedDelivery = workspaceDelivery ? mergeDelivery(correctedOutput, workspaceDelivery) : correctedOutput;
      const mergedDelivery = mergeDelivery(delivery, correctedDelivery);
      await checkpoint(jobId, `Corrección ${round}`, Math.min(progress + 8, 95), 'Desarrollador (corrección)', mergedDelivery, { proposal, critique, strategy, coherence, coherenceReview: null, coherenceReviewRound: null, activeValidationRound: round + 1, delivery: mergedDelivery, validation: null, syntax: null, validationRound: round, lastCheckpoint: `correction-${round}` });
      await saveArtifacts(jobId, mergedDelivery);
      delivery = mergedDelivery; validation = null; syntax = null; payload = (await getPayload(jobId))?.payload || {}; round += 1; resumeState = getValidationResumeState(payload, round - 1);
    }
    const finalPayload = (await getPayload(jobId))?.payload || {};
    const reviewTranscript = appendEntries(finalPayload.transcript, [{
      at: new Date().toISOString(), agent: 'sistema', type: 'check',
      content: 'El comité terminó sus intentos automáticos, pero la validación no aprobó todos los criterios. La entrega queda pendiente de revisión humana; no se considera aprobada.'
    }]);
    await updateJob(jobId, { status: 'needs_review', stage: 'Requiere revisión humana', progress: 99, attempt: MAX_ROUNDS, error: 'La revisión automática no aprobó todos los criterios; requiere revisión humana.', payload: { ...finalPayload, proposal, critique, strategy, coherence, delivery, validation, syntax, transcript: reviewTranscript, activeStage: null, result: { status: 'needs_review', delivery, validation, syntax }, lastCheckpoint: 'needs_review' } });
  } catch (error) {
    const current = await getPayload(jobId);
    if (error?.code === 'TASK_TOKEN_BUDGET' && current) {
      const patch = buildBudgetPausePatch(current, error);
      console.warn('[worker][token_budget_paused]', JSON.stringify({ jobId, usedTokens: error.usedTokens ?? null, tokenLimit: error.tokenLimit ?? null, estimatedInputTokens: error.estimatedInputTokens ?? null, checkpoint: patch.payload.lastCheckpoint, progress: patch.progress }));
      await updateJob(jobId, patch);
      // When this task reaches its configured budget, fork a durable continuation automatically. The database
      // row lock inside createContinuationJob makes this transition idempotent.
      const continuation = await createContinuationJob(jobId);
      if (continuation?.error) {
        console.error('[worker][token_task_continuation_failed]', JSON.stringify({ jobId, status: continuation.status || null, error: continuation.error }));
        return { blocked: true, reason: patch.error };
      }
      console.warn('[worker][token_task_continuation]', JSON.stringify({
        sourceJobId: jobId, continuationJobId: continuation.job.id,
        created: continuation.created, tokenBudget: 1000000,
        continuationNumber: continuation.job.attempt || null,
        checkpoint: patch.payload.lastCheckpoint
      }));
      return { deferred: true, retryAfterMs: 1000, continuationJobId: continuation.job.id, budgetContinuation: true };
    }
    if (error?.code === 'PROVIDER_TEMPORARY' && current) {
      const failureStreak = Math.min(20, (Number(current.payload.providerFailureStreak) || 0) + 1);
      const retryAfterMs = getDeferredCooldownMs(Number(error.retryAfterMs) || 30000, failureStreak);
      const retryAt = new Date(Date.now() + retryAfterMs).toISOString();
      const reason = String(error.message || 'Proveedor temporalmente no disponible').slice(0, 1200);
      const transcript = appendEntries(current.payload.transcript, [{ at: new Date().toISOString(), agent: 'sistema', type: 'retry', content: `Tarea pausada de forma segura. Motivo: ${reason} Próximo intento automático: ${retryAt}. Se conserva el checkpoint ${current.payload.lastCheckpoint || 'guardado'}.` }]);
      await updateJob(jobId, { status: 'queued', stage: 'Esperando disponibilidad del proveedor', progress: current.publicJob.progress, error: null, payload: { ...current.payload, transcript, retryAt, providerFailureStreak: failureStreak, providerBlock: { code: error.code, model: error.providerModel || null, retry: error.providerRetry || null, failureStreak, reason, retryAfterMs }, lastCheckpoint: current.payload.lastCheckpoint || 'provider-deferred', activeStage: null } });
      console.warn('[worker][provider_deferred]', JSON.stringify({ jobId, model: error.providerModel || null, retry: error.providerRetry || null, retryAfterMs, retryAt, checkpoint: current.payload.lastCheckpoint || null }));
      return { deferred: true, retryAfterMs };
    }
    console.error('[worker][job_failed]', JSON.stringify({
      jobId,
      name: String(error?.name || 'Error').slice(0, 100),
      message: String(error?.message || error).slice(0, 1200),
      stack: String(error?.stack || '').slice(0, 4000)
    }));
    if (current) {
      const transcript = appendEntries(current.payload.transcript, [{ at: new Date().toISOString(), agent: 'sistema', type: 'error', content: String(error?.stack || error?.message || error).slice(0, 12000) }]);
      await updateJob(jobId, { status: 'failed', stage: 'Error de procesamiento', error: 'La tarea se interrumpió por un error. Consultá el detalle técnico y corregí la configuración si corresponde.', payload: { ...current.payload, transcript, lastCheckpoint: current.payload.lastCheckpoint || 'error' } });
    }
  }
}
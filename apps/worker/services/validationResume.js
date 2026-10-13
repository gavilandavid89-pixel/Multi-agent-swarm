export function getValidationResumeState(payload = {}, attempt = 0) {
  const validation = payload.validation || null;
  const syntax = payload.syntax || null;
  const auditCheckpointRound = Number(String(payload.lastCheckpoint || '').match(/^Auditoría de coherencia (\d+)$/)?.[1]) || 0;
  const round = (payload.validationRound && validation && syntax)
    ? Number(payload.validationRound)
    : (Number(payload.activeValidationRound) || auditCheckpointRound || Number(attempt || 0) + 1);
  const coherenceReview = (Number(payload.coherenceReviewRound) === round && payload.coherenceReview)
    ? payload.coherenceReview
    : (auditCheckpointRound === round && payload.coherenceReview ? payload.coherenceReview : null);
  return { round, coherenceReview, validationSaved: Boolean(payload.validationRound === round && validation && syntax) };
}

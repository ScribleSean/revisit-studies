const kinds = new Set(['hesitation', 'confusion_word', 'scene_change', 'reading', 'confused_transition', 'active_interaction']);

export function validateEvents(events, duration) {
  if (!Array.isArray(events) || events.length > 100000 || events.some((event) => !event || !kinds.has(event.type) || !Number.isFinite(event.timestamp) || event.timestamp < 0 || event.timestamp > duration)) throw new Error('Invalid evaluation events');
}

function counts(tp, predicted, expected) {
  return {
    tp, fp: predicted - tp, fn: expected - tp,
    precision: predicted ? tp / predicted : null,
    recall: expected ? tp / expected : null,
    f1: predicted + expected ? 2 * tp / (predicted + expected) : null,
  };
}

/** Maximum one-to-one matching for same-type timestamps within a fixed tolerance. */
export function matchEvents(expected, predicted, duration, toleranceSeconds = 2) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) throw new Error('Invalid evaluation duration or tolerance');
  validateEvents(expected, duration); validateEvents(predicted, duration);
  const perType = {};
  let total = 0;
  for (const type of kinds) {
    const truth = expected.filter((event) => event.type === type).map((event) => event.timestamp).sort((a, b) => a - b);
    const observed = predicted.filter((event) => event.type === type).map((event) => event.timestamp).sort((a, b) => a - b);
    let i = 0; let j = 0; let tp = 0;
    while (i < truth.length && j < observed.length) {
      if (observed[j] < truth[i] - toleranceSeconds) j += 1;
      else if (truth[i] < observed[j] - toleranceSeconds) i += 1;
      else { tp += 1; i += 1; j += 1; }
    }
    if (truth.length || observed.length) perType[type] = counts(tp, observed.length, truth.length);
    total += tp;
  }
  return { toleranceSeconds, ...counts(total, predicted.length, expected.length), perType };
}

const defaults = Object.freeze({ hesitation: 1, confusion_word: 1.5, confused_transition: 2, scene_change: 0.5, reading: 0, active_interaction: -0.5 });
const tokens = (text) => text.toLowerCase().match(/[\p{L}\p{N}]+(?:'\p{L}+)?/gu) || [];
const containsPhrase = (text, phrase) => {
  const words = tokens(text);
  const target = tokens(phrase);
  return target.length > 0 && words.some((_, i) => target.every((word, j) => words[i + j] === word));
};

/** Report section 4.6: raw additive scores, fixed 30s windows, 3s OCR grounding bins.
 * The report omits formula operators. Activity is subtractive as in the old implementation,
 * using the report's stated magnitude 0.5. Scores are evidence weights, not probabilities.
 */
export function scoreConfusion(events, ocr, duration, { windowSeconds = 30, groundingMultiplier = 1.5, weights = defaults } = {}) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(windowSeconds) || windowSeconds <= 0 || Math.ceil(duration / windowSeconds) > 100000 || !Number.isFinite(groundingMultiplier) || groundingMultiplier < 0) throw new RangeError('Invalid confusion scoring options');
  const effective = { ...defaults, ...weights };
  if (Object.values(effective).some((value) => !Number.isFinite(value))) throw new RangeError('Invalid confusion weights');
  const windows = Array.from({ length: Math.ceil(duration / windowSeconds) }, (_, i) => ({ start: i * windowSeconds, end: Math.min((i + 1) * windowSeconds, duration), score: 0, evidence: [] }));
  const frames = new Map();
  for (const frame of ocr) {
    if (!Number.isFinite(frame.timestamp) || frame.timestamp < 0 || frame.timestamp >= duration || typeof frame.text !== 'string') throw new TypeError('Invalid OCR frame');
    const bin = Math.floor(frame.timestamp / 3);
    if (!frames.has(bin)) frames.set(bin, []);
    frames.get(bin).push(frame.text);
  }
  for (const event of events) {
    if (!Object.hasOwn(defaults, event.type) || !Number.isFinite(event.timestamp) || event.timestamp < 0 || event.timestamp > duration || typeof event.evidence !== 'string') throw new TypeError('Invalid timeline event');
    // A point at the recording's exact end belongs to the final displayed window.
    const window = windows[Math.min(Math.floor(event.timestamp / windowSeconds), windows.length - 1)];
    const phrase = event.evidence.match(/^Matched:\s*(.+)$/i)?.[1];
    const grounded = event.type === 'confusion_word' && phrase && (frames.get(Math.floor(event.timestamp / 3)) || []).some((text) => containsPhrase(text, phrase));
    const weight = effective[event.type] * (grounded ? groundingMultiplier : 1);
    window.score += weight;
    window.evidence.push(`${event.timestamp.toFixed(2)}s ${event.type}: ${weight >= 0 ? '+' : ''}${weight}${grounded ? ' (OCR grounded)' : ''} · ${event.evidence}`);
  }
  return windows;
}

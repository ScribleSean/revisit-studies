import { describe, expect, it } from 'vitest';

import { parseTimelineEventsJson } from './timelineEventTypes';

describe('parseTimelineEventsJson', () => {
  it('accepts Phase 13.3 timeline types', () => {
    const raw = JSON.stringify({
      events: [
        { type: 'reading', timestamp: 5, evidence: 'Silence' },
        { type: 'confused_transition', timestamp: 6, evidence: 'Scene' },
        { type: 'active_interaction', timestamp: 15, evidence: 'Busy' },
      ],
    });
    const parsed = parseTimelineEventsJson(raw);
    expect(parsed).toHaveLength(3);
    expect(parsed.map((e) => e.type)).toEqual(['reading', 'confused_transition', 'active_interaction']);
  });
});

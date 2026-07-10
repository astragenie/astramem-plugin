/**
 * Tests for src/lib/save-marker.ts — inline save marker (issue #40).
 */
import { describe, it, expect } from 'vitest';
import { formatSaveMarker, saveMarkerEnabled, SAVE_MARKER_EMOJI } from '../../src/lib/save-marker.ts';

describe('formatSaveMarker', () => {
  it('returns null when the total is 0 (zero-suppression)', () => {
    expect(formatSaveMarker({})).toBeNull();
    expect(formatSaveMarker({ fact: 0, lesson: 0 })).toBeNull();
  });

  it('formats a single type', () => {
    expect(formatSaveMarker({ fact: 1 })).toBe('🧠 astramem · saved 1 (💡 1 fact)');
  });

  it('groups multiple types in canonical enum order (decision, fact, lesson, ...)', () => {
    // Inserted out of canonical order to prove the output re-sorts them.
    expect(formatSaveMarker({ lesson: 1, fact: 2 })).toBe('🧠 astramem · saved 3 (💡 2 fact · 📝 1 lesson)');
  });

  it('computes the total across all non-zero types', () => {
    expect(formatSaveMarker({ decision: 2, note: 3, event: 1 })).toBe(
      '🧠 astramem · saved 6 (🧭 2 decision · 📌 3 note · 📅 1 event)',
    );
  });

  it('omits zero-count types from the segment list', () => {
    expect(formatSaveMarker({ fact: 1, lesson: 0 })).toBe('🧠 astramem · saved 1 (💡 1 fact)');
  });

  it('falls back to 🧠 for an unlisted type and orders it after canonical types', () => {
    expect(formatSaveMarker({ fact: 1, mystery_type: 2 })).toBe(
      '🧠 astramem · saved 3 (💡 1 fact · 🧠 2 mystery_type)',
    );
  });

  it('covers every canonical type with its documented emoji', () => {
    const byType = {
      decision: 1, fact: 1, lesson: 1, command: 1, todo: 1,
      note: 1, event: 1, preference: 1, task_result: 1, summary: 1,
    };
    const marker = formatSaveMarker(byType)!;
    for (const [type, emoji] of Object.entries(SAVE_MARKER_EMOJI)) {
      expect(marker).toContain(`${emoji} 1 ${type}`);
    }
    expect(marker.startsWith('🧠 astramem · saved 10 (')).toBe(true);
  });
});

describe('saveMarkerEnabled', () => {
  it('defaults to enabled when MEMORY_SAVE_MARKER is unset', () => {
    expect(saveMarkerEnabled({})).toBe(true);
  });

  it('stays enabled for any value other than "0"', () => {
    expect(saveMarkerEnabled({ MEMORY_SAVE_MARKER: '1' })).toBe(true);
    expect(saveMarkerEnabled({ MEMORY_SAVE_MARKER: 'false' })).toBe(true);
  });

  it('disables when MEMORY_SAVE_MARKER=0', () => {
    expect(saveMarkerEnabled({ MEMORY_SAVE_MARKER: '0' })).toBe(false);
  });
});

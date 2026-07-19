/**
 * Suggestion Mode — Format Change Handler
 *
 * When suggestion mode is active and a formatting mark is added or removed
 * (e.g. bold/italic/underline/fontSize/color) the change should be tracked
 * as a pending format change (`w:rPrChange`) rather than applied directly.
 *
 * Strategy — `appendTransaction` hook:
 *   1. Detect incoming transactions that carry addMark / removeMark steps
 *      for formatting marks (not structural marks like insertion/deletion).
 *   2. For each affected text segment, capture the *previous* formatting by
 *      reading the marks that were on the node before the step (from oldState).
 *   3. Attach a `formatChange` mark to those segments carrying the previous
 *      formatting as a JSON payload.
 *
 * The transaction itself is NOT rolled back — the new formatting is applied
 * normally so the text visually shows the user's requested style. The
 * `formatChange` mark is additive metadata that drives:
 *   - The orange underline visual in the painter / PM toDOM view
 *   - The `<w:rPrChange>` element on DOCX round-trip
 *   - Accept/reject commands (accept = remove the formatChange mark; reject =
 *     remove new format marks + restore previousFormatting marks)
 */

import type { Transaction } from 'prosemirror-state';
import type { EditorState } from 'prosemirror-state';
import type { Step } from 'prosemirror-transform';
import type { SuggestionModeState } from '../state';
import { SUGGESTION_META, SUGGESTION_BYPASS_META } from '../state';
import { mintRevisionId } from '../../revisionIds';

/**
 * Formatting mark names that should be tracked as format changes when
 * suggestion mode is active. Structural marks (insertion/deletion/formatChange)
 * and non-formatting marks (hyperlink/comment/footnoteRef) are excluded.
 */
export const TRACKED_FORMATTING_MARKS = new Set([
  'bold',
  'italic',
  'underline',
  'strike',
  'textColor',
  'highlight',
  'fontSize',
  'fontFamily',
  'superscript',
  'subscript',
  'allCaps',
  'smallCaps',
  'characterSpacing',
  'emboss',
  'imprint',
  'textShadow',
  'emphasisMark',
  'textOutline',
  'hidden',
  'rtl',
  'textEffect',
]);

/**
 * Duck-typed shape shared by AddMarkStep and RemoveMarkStep.
 * Both expose `from`, `to`, and `mark` directly (ProseMirror source).
 */
interface MarkStep extends Step {
  from: number;
  to: number;
  mark: { type: { name: string } };
}

/**
 * Returns true when the step looks like an AddMarkStep or RemoveMarkStep
 * acting on a tracked formatting mark.
 */
function isFormattingMarkStep(step: Step): step is MarkStep {
  const s = step as Partial<MarkStep>;
  if (typeof s.from !== 'number' || typeof s.to !== 'number' || !s.mark) return false;
  const jsonId = (step as { jsonID?: string }).jsonID;
  if (jsonId !== 'addMark' && jsonId !== 'removeMark') return false;
  return TRACKED_FORMATTING_MARKS.has(s.mark.type.name);
}

/**
 * Returns true if any step in the transaction is a formatting-mark step.
 */
export function hasFormattingMarkSteps(tr: Transaction): boolean {
  return tr.steps.some(isFormattingMarkStep);
}

/**
 * Called from `appendTransaction` when suggestion mode is active and the
 * incoming transaction contains formatting-mark changes. Returns a new
 * transaction that attaches `formatChange` marks covering the same ranges,
 * with the pre-change formatting encoded as JSON in `previousFormatting`.
 *
 * @param transactions  The transactions just applied.
 * @param oldState      Editor state *before* the transactions (to read original marks).
 * @param newState      Editor state *after* the transactions (to build the append-tr on).
 * @param pluginState   Active suggestion mode state (author/date).
 */
export function appendFormatChangeMark(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
  pluginState: SuggestionModeState
): Transaction | null {
  const formatChangeType = newState.schema.marks.formatChange;
  if (!formatChangeType) return null; // mark not in schema (should not happen)

  const revisionId = mintRevisionId();
  const author = pluginState.author || 'Unknown';
  const date = new Date().toISOString();

  // Collect all from–to ranges that were touched by formatting steps,
  // together with the marks that existed on each text node *before* the change.
  // We read them from `oldState.doc`.
  const ranges: Array<{
    from: number;
    to: number;
    previousFormattingJson: string;
  }> = [];

  for (const tr of transactions) {
    for (const step of tr.steps) {
      if (!isFormattingMarkStep(step)) continue;

      const stepFrom = step.from;
      const stepTo = step.to;

      // Walk the old-state document in [stepFrom, stepTo) to capture the
      // previous marks for each text node.
      oldState.doc.nodesBetween(stepFrom, stepTo, (node, pos) => {
        if (!node.isText) return; // descend into non-text nodes
        const start = Math.max(pos, stepFrom);
        const end = Math.min(pos + node.nodeSize, stepTo);
        if (start >= end) return;

        // Skip text that already carries a formatChange, insertion, or deletion mark.
        const alreadyTracked = node.marks.some(
          (m) =>
            m.type.name === 'formatChange' ||
            m.type.name === 'insertion' ||
            m.type.name === 'deletion'
        );
        if (alreadyTracked) return;

        // Capture only the formatting marks (not structural/comment marks).
        const previousMarks = node.marks.filter((m) => TRACKED_FORMATTING_MARKS.has(m.type.name));

        // Serialize to a JSON object keyed by mark name for compact storage.
        // Simple boolean marks (bold, italic) are stored as `true`;
        // marks with attrs are stored as their attrs object.
        const previousFormattingObj: Record<string, unknown> = {};
        for (const m of previousMarks) {
          const hasAttrs = m.attrs && Object.keys(m.attrs).length > 0;
          previousFormattingObj[m.type.name] = hasAttrs ? m.attrs : true;
        }

        ranges.push({
          from: start,
          to: end,
          previousFormattingJson: JSON.stringify(previousFormattingObj),
        });
      });
    }
  }

  if (ranges.length === 0) return null;

  const appendTr = newState.tr;
  appendTr.setMeta(SUGGESTION_META, true);
  appendTr.setMeta(SUGGESTION_BYPASS_META, true); // don't re-intercept

  for (const { from, to, previousFormattingJson } of ranges) {
    appendTr.addMark(
      from,
      to,
      formatChangeType.create({
        revisionId,
        author,
        date,
        previousFormatting: previousFormattingJson,
      })
    );
  }

  return appendTr;
}

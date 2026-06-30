/**
 * The pagination model — the layout engine's entry point.
 *
 * Consumers want three things from here: the data contract (`types`), the flow
 * entry point (`layOutPages`), and the handful of classification predicates
 * that decide whether a block participates in the flow at all.
 *
 * @packageDocumentation
 * @public
 */

// The public data contract: blocks, measures, fragments, pages.
export * from './types';

// The flow: blocks + measures → positioned pages.
export { layOutPages } from './pageComposer';

// Section geometry, resolved into an immutable schedule up front.
export { collectSectionConfigs } from './sectionPlan';
export type { SectionPlan } from './sectionPlan';

// The spacing-collapse rule, shared by the flow and the column balancer.
export { spaceBefore, spaceAfter, collapsedGap } from './blockSpacingRules';

// Column balancing (best-effort — see the module note).
export { balancedColumnBottom } from './columnBalancing';
export type { BalancingRegion } from './columnBalancing';

// Table row-break geometry: where a row may be cut without slicing a glyph.
export { buildTableRowBreakInfo, snapRowBreak } from './tableRowBreak';
export type { TableRowBreakInfo } from './tableRowBreak';

// How a text box relates to the text around it.
export {
  isFloatingTextBoxBlock,
  floatingTextBoxReservesBand,
  floatingTextBoxWrapsText,
} from './textBoxFlow';
export type { TextBoxFlowAttrs } from './textBoxFlow';

// The OOXML wrap taxonomy, re-exported so float-aware consumers need only this
// barrel (the measure pipeline classifies blocks and text boxes together).
export { isFloatingWrapType, isWrapNone, wrapsAroundText } from '../docx/wrapTypes';
export type { WrapType } from '../docx/wrapTypes';

// Inline content-control widgets carried on a run.
export type { InlineSdtWidget } from './inlineSdtWidgets';

// Page lookup for a document position, when the painted DOM can't answer
// (virtualized pages have no DOM yet).
export { findPageIndexContainingPmPos } from './findPageIndexContainingPmPos';

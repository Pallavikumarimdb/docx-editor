/**
 * The seam between the editing state and what's on screen.
 *
 * The editor has two representations of the document and they update at
 * different times. ProseMirror's state changes *synchronously*, the instant a
 * key is pressed. The painted pages are rebuilt *asynchronously*, a frame or
 * more later, because re-laying out a document is too expensive to do inside a
 * keystroke.
 *
 * Everything drawn on top of the pages — the caret, the selection highlight,
 * comment and tracked-change decorations — is computed by reading document
 * positions out of the *new* state and looking them up in the *painted* DOM. So
 * there is a window, every keystroke, where those two disagree. Draw in that
 * window and the caret lands next to where the text used to be, then jumps when
 * layout commits. It reads as the cursor stuttering.
 *
 * This class closes the window. It is a version counter and nothing more:
 *
 *  - the **state sequence** ticks on every document-changing transaction;
 *  - a layout pass records which sequence it started from, and reports back when
 *    it has painted it;
 *  - {@link isSafeToRender} is simply "has the paint caught up with the state".
 *
 * Overlays ask that question before drawing, and register with {@link onRender}
 * to be told when the answer flips to yes.
 *
 * @packageDocumentation
 * @public
 */

/** Called when the painted DOM has caught up and overlays may safely draw. */
type RenderListener = () => void;

/**
 * Tracks whether the painted pages reflect the current editing state.
 *
 * @public
 */
export class SelectionBridge {
  /** Bumped by every document-changing transaction. */
  private stateSeq = 0;

  /** The state sequence the most recent completed layout painted. */
  private paintedSeq = 0;

  /** True while a layout pass is in flight. */
  private laying = false;

  /**
   * A render was asked for while the paint was stale. Held so it can fire the
   * moment layout catches up — dropping it would leave the overlay blank until
   * the user's *next* keystroke, which is how a caret goes missing entirely.
   */
  private renderPending = false;

  private listeners = new Set<RenderListener>();

  /**
   * The current state sequence. A layout pass reads this when it starts and
   * hands it back to {@link onLayoutComplete}, so a pass that was overtaken by a
   * newer edit doesn't claim to have painted it.
   */
  getStateSeq(): number {
    return this.stateSeq;
  }

  /** The document changed. */
  incrementStateSeq(): void {
    this.stateSeq++;
  }

  /** A layout pass has begun. */
  onLayoutStart(): void {
    this.laying = true;
  }

  /**
   * A layout pass finished, having laid out state sequence `epoch`.
   *
   * If the document changed again while it ran, `epoch` is behind
   * {@link getStateSeq} — the paint is already stale on arrival, and a newer
   * pass is coming. Recording it as painted anyway would let overlays draw
   * against DOM that is one edit out of date.
   */
  onLayoutComplete(epoch: number): void {
    this.laying = false;
    if (epoch > this.paintedSeq) this.paintedSeq = epoch;

    if (this.renderPending && this.isSafeToRender()) {
      this.renderPending = false;
      this.emit();
    }
  }

  /**
   * True when the painted DOM reflects the current state — the only moment at
   * which reading positions out of it gives the right answer.
   */
  isSafeToRender(): boolean {
    return !this.laying && this.paintedSeq >= this.stateSeq;
  }

  /**
   * Ask the overlays to redraw.
   *
   * Fires immediately when the paint is current; otherwise it is deferred until
   * the layout in flight completes. Either way the redraw happens exactly once,
   * against DOM that matches the state.
   */
  requestRender(): void {
    if (this.isSafeToRender()) {
      this.emit();
      return;
    }
    this.renderPending = true;
  }

  /**
   * Subscribe to redraw notifications. Returns the unsubscribe function.
   */
  onRender(listener: RenderListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    // Snapshot: a listener that unsubscribes during the notification must not
    // perturb the iteration.
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
  }
}

// Feedback Studio — one undo stack for everything the reviewer can change from
// the List: a status change, a retyped comment, a moved pin, a delete, a bulk
// action. Each entry knows how to reverse itself with the API call that puts
// the previous state back. Ctrl+Z and the "Undo" button on a toast both call
// undo(); the last ten actions are kept.

import { toast, toastError } from '/__feedback/overlay/ui.mjs';
import { emit } from '/__feedback/overlay/events.mjs';
import { t } from '/__feedback/overlay/i18n.mjs';

const MAX = 10;
const stack = [];   // [{ label, run }] — run() reverses the action and returns a promise
let busy = false;

// Record an action that can be reversed. `label` is what the toast says after
// undoing ("Undone: the status change"). Returns the entry.
export function pushUndo(label, run) {
  const entry = { label, run, at: Date.now() };
  stack.push(entry);
  if (stack.length > MAX) stack.shift();
  return entry;
}

// A toast for an action that has an undo: the button reverses it.
export function toastUndo(msg, label, run, opts = {}) {
  pushUndo(label, run);
  toast(msg, { actionLabel: t('Undo'), duration: opts.duration || 6000, onAction: () => undo() });
}

export function undoDepth() { return stack.length; }

// Reverse the most recent action. A failed reversal keeps the entry off the
// stack (retrying the same call would fail the same way) and says why.
export async function undo() {
  if (busy) return;
  const entry = stack.pop();
  if (!entry) { toast(t('Nothing to undo'), { duration: 1500 }); return; }
  busy = true;
  try {
    await entry.run();
    emit('refresh');
    toast(t('Undone: {what}', { what: entry.label }), { duration: 2500 });
  } catch (e) {
    emit('refresh');
    toastError(t('Could not undo — {error}', { error: e.message }));
  } finally { busy = false; }
}

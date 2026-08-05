import type { GovernorSnapshot } from '@blackide/agent-core/core/agent-governor';
import type { OfficeSnapshot } from '@blackide/agent-core/core/office-model';
import type { OfficeFile } from './OfficeView';

// ─── The Office's webview-side state, reduced in one place ──────────────────
//
// Extracted when the Front Desk arrived (M73). Both Office surfaces consume the same four
// messages, and a patch merge is exactly the kind of thing that is easy to write twice and
// almost impossible to notice diverging: the second copy would look right, pass review,
// and be one field-clear behind the first for as long as nobody put the two windows side
// by side.
//
// Pure and framework-free — a reducer, not a hook — so it can be driven from `useReducer`
// in one surface and from `useState` setters in another without either dictating the
// other's shape.

export interface OfficeState {
    snapshot?: OfficeSnapshot;
    files: OfficeFile[];
}

export const EMPTY_OFFICE: OfficeState = { files: [] };

/**
 * Fold one message into the Office's state.
 *
 * Anything it does not own is returned unchanged, by reference — so the Front Desk can
 * hand it every message the window receives, while the Manager panel, whose one listener
 * serves six tabs, routes the four it recognises.
 */
export function reduceOffice(state: OfficeState, message: any): OfficeState {
    switch (message?.type) {
        case 'officeSync':
            return { ...state, snapshot: message.value };

        /*
         * A patch carries only the fields that changed for one item.
         *
         * Merged rather than replacing the item, because the patch channel deliberately
         * omits everything it did not touch — an item's title, branch and affordances come
         * from the roster and would be lost by a wholesale swap. `fields` is spread last so
         * an explicit `activity: undefined` (the run's tool finished) actually clears it,
         * which a `{...item, ...defined-only}` merge would silently ignore.
         */
        case 'officePatch': {
            if (!state.snapshot) return state;
            const { id, fields } = message.value ?? {};
            return {
                ...state,
                snapshot: {
                    ...state.snapshot,
                    items: state.snapshot.items.map(item =>
                        item.id === id ? { ...item, ...fields } : item),
                    desks: state.snapshot.desks.map(desk =>
                        desk.item?.id === id
                            ? { ...desk, item: { ...desk.item!, ...fields } }
                            : desk),
                },
            };
        }

        case 'officeGovernor':
            // Arrives on its own cadence from the inbox poll, so it must not wait for a full
            // sync: the header's spend tile is the one number that moves while nothing else does.
            if (!state.snapshot) return state;
            return {
                ...state,
                snapshot: { ...state.snapshot, governor: message.value as GovernorSnapshot },
            };

        case 'officeFiles':
            return { ...state, files: message.value || [] };
    }
    return state;
}

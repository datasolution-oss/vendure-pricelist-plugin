import { ID } from '@vendure/common/lib/shared-types';
import { RequestContext, VendureEvent } from '@vendure/core';

/**
 * Discriminator for `PriceListAccessChangeEvent.changeKind`.
 */
export type PriceListAccessChangeKind =
    | 'everyone'
    | 'customer'
    | 'customerGroup';

/**
 * Emitted whenever an access mutation modifies the M2M / boolean
 * access fields on a `PriceList` (Stage 1B):
 *   - `setPriceListAssignedToEveryone` → `changeKind = 'everyone'`
 *   - `addCustomersToPriceList` / `removeCustomersFromPriceList` →
 *     `changeKind = 'customer'`, with `affectedCustomerIds`
 *     populated.
 *   - `addCustomerGroupsToPriceList` /
 *     `removeCustomerGroupsFromPriceList` →
 *     `changeKind = 'customerGroup'`, with
 *     `affectedCustomerGroupIds` populated.
 *
 * Subscribers (Stage 2 cache invalidation) listen on this event to
 * bust the relevant `pricelist:resolution` cache tags. See
 * PLAN-STAGE-2 §Q3 for the per-changeKind invalidation policy.
 *
 * Replaces the planned `PriceListAssignmentEvent` from the
 * pre-Stage-1B design — the polymorphic assignment table no longer
 * exists since Stage 1B batch 2.
 */
export class PriceListAccessChangeEvent extends VendureEvent {
    constructor(
        public ctx: RequestContext,
        public priceListId: ID,
        public channelId: ID,
        public changeKind: PriceListAccessChangeKind,
        public affectedCustomerIds: ID[] = [],
        public affectedCustomerGroupIds: ID[] = [],
        public assignedToEveryone?: boolean,
    ) {
        super();
    }
}

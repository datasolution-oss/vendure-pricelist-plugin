import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import {
    EventBus,
    Logger,
    OrderLine,
    OrderLineEvent,
    TransactionalConnection,
} from '@vendure/core';

import { loggerCtx, PRICELIST_PLUGIN_OPTIONS } from '../constants';
import { PriceListLookupService } from '../services';
import { PluginInitOptions } from '../types';

/**
 * Stage 3 §2.4 — denormalised provenance snapshot on the order line
 * (meta-plan §0.2.11, support/forensics).
 *
 * Registered as a **blocking** event handler so the snapshot write
 * completes inside the same request/transaction as `addItemToOrder`:
 * the non-blocking `eventBus.ofType().subscribe()` API is fire-and-forget
 * and races with downstream reads (the e2e provenance specs flaked because
 * the mutation returned before the subscriber's UPDATE landed). Blocking
 * handlers were introduced in Vendure 2.2 exactly for this kind of
 * post-mutation persistence step.
 *
 * Only fires on `created`, so the snapshot reflects the price the customer
 * first saw; the JSON column stands alone (no FK), so deleting the PriceList
 * later does not affect placed orders. Errors are caught and logged — a
 * failure to record provenance must not roll back the order itself.
 */
@Injectable()
export class OrderLineProvenanceSubscriber implements OnModuleInit {
    constructor(
        private eventBus: EventBus,
        private connection: TransactionalConnection,
        private lookup: PriceListLookupService,
        @Inject(PRICELIST_PLUGIN_OPTIONS) private options: PluginInitOptions,
    ) {}

    onModuleInit(): void {
        // Opt-out: when `recordOrderLineProvenance` is false, we don't
        // register the handler at all — no per-event overhead, and no
        // `customFields.pricelistProvenance` writes.
        if (this.options.recordOrderLineProvenance === false) return;
        this.eventBus.registerBlockingEventHandler({
            event: OrderLineEvent,
            id: 'pricelist-order-line-provenance',
            handler: async event => {
                // Subscribe to 'updated', not 'created'. Vendure creates
                // the OrderLine at qty 0 (fires 'created'), then
                // `updateOrderLineQuantity` sets the real quantity and
                // fires 'updated'. We need the post-quantity event so
                // `lookup.resolvePrice(..., quantity)` matches the right
                // `stepQuantity` tier.
                if (event.type !== 'updated') return;
                const { ctx, orderLine } = event;
                if (!orderLine.productVariant) return;
                // Skip only if a real snapshot string already exists.
                // After `getOrCreateOrderLine.save()`, TypeORM materialises
                // the nullable column as `null` (not `undefined`), so we
                // must treat `null` as "not yet snapshotted". The trade-off:
                // an orderLine whose first snapshot resolved to "no list
                // applied" will re-snapshot on every later 'updated' event
                // — harmless (same `null` result) and last-write-wins is
                // acceptable for the support/forensics use case.
                const existing = (orderLine.customFields as { pricelistProvenance?: string | null })
                    ?.pricelistProvenance;
                if (typeof existing === 'string') return;
                try {
                    const resolved = await this.lookup.resolvePrice(
                        ctx,
                        orderLine.productVariant,
                        ctx.currencyCode,
                        orderLine.quantity,
                    );
                    const provenanceJson = resolved
                        ? JSON.stringify(resolved.provenance)
                        : null;
                    // Mutate the in-memory entity FIRST. The
                    // `addItemToOrder` flow saves the orderLine again
                    // downstream (via `applyPriceAdjustments`); a bare
                    // DB UPDATE here would be silently overwritten by
                    // that save unless the in-memory object also carries
                    // our value. The UPDATE below is the safety net for
                    // code paths that don't re-save the line.
                    orderLine.customFields = {
                        ...orderLine.customFields,
                        pricelistProvenance: provenanceJson,
                    };
                    await this.connection
                        .getRepository(ctx, OrderLine)
                        .update(orderLine.id, { customFields: orderLine.customFields });
                } catch (err) {
                    Logger.error(
                        `OrderLine provenance snapshot failed: ${(err as Error).message}`,
                        loggerCtx,
                    );
                }
            },
        });
    }
}

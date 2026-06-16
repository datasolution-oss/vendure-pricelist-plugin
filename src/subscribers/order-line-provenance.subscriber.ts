import { Injectable, OnModuleInit } from '@nestjs/common';
import {
    EventBus,
    Logger,
    OrderLine,
    OrderLineEvent,
    TransactionalConnection,
} from '@vendure/core';
import { filter } from 'rxjs/operators';

import { loggerCtx } from '../constants';
import { PriceListLookupService } from '../services';

/**
 * Stage 3 §2.4 — denormalised provenance snapshot on the order line
 * (meta-plan §0.2.11, support/forensics).
 *
 * On `OrderLineEvent('created')` (fires post-persist, same request as
 * addItemToOrder), re-resolve the price for the line's variant + quantity
 * (free — hits the per-request lookup cache) and write the JSON-stringified
 * provenance to `OrderLine.customFields.pricelistProvenance`. Only fires on
 * `created`, so the snapshot reflects the price the customer first saw; the
 * JSON column stands alone (no FK), so deleting the PriceList later does not
 * affect placed orders.
 */
@Injectable()
export class OrderLineProvenanceSubscriber implements OnModuleInit {
    constructor(
        private eventBus: EventBus,
        private connection: TransactionalConnection,
        private lookup: PriceListLookupService,
    ) {}

    onModuleInit(): void {
        this.eventBus
            .ofType(OrderLineEvent)
            .pipe(filter(e => e.type === 'created'))
            .subscribe(async event => {
                try {
                    const { ctx, orderLine } = event;
                    if (!orderLine.productVariant) return;
                    const resolved = await this.lookup.resolvePrice(
                        ctx,
                        orderLine.productVariant,
                        ctx.currencyCode,
                        orderLine.quantity,
                    );
                    const provenanceJson = resolved
                        ? JSON.stringify(resolved.provenance)
                        : null;
                    await this.connection.getRepository(ctx, OrderLine).update(
                        orderLine.id,
                        {
                            customFields: {
                                ...orderLine.customFields,
                                pricelistProvenance: provenanceJson,
                            },
                        },
                    );
                } catch (err) {
                    Logger.error(
                        `OrderLine provenance snapshot failed: ${(err as Error).message}`,
                        loggerCtx,
                    );
                }
            });
    }
}

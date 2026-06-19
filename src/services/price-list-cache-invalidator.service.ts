import { Injectable, OnModuleInit } from '@nestjs/common';
import {
    CacheService,
    CustomerGroupChangeEvent,
    EventBus,
    Logger,
    ProductVariantPriceEvent,
    TransactionalConnection,
} from '@vendure/core';
import {
    EntitySubscriberInterface,
    InsertEvent,
    RemoveEvent,
    UpdateEvent,
} from 'typeorm';

import { loggerCtx } from '../constants';
import { PriceListAccessChangeEvent } from '../events/price-list-access-change.event';

/** Cache namespaces owned by Stage 2 (see DefaultPriceListResolutionStrategy
 *  + PriceListLookupService). Busting both clears every resolution and
 *  computed-price entry. */
const RESOLUTION_NS = 'pricelist:resolution';
const COMPUTED_NS = 'pricelist:computed';

/**
 * Pricelist entity names whose writes change resolution/cascade output and
 * therefore must bust the caches. `PriceListChannelAccess` is intentionally
 * EXCLUDED — access changes go through the precise, per-customer
 * `PriceListAccessChangeEvent` path below (finer-grained than the broad
 * namespace nuke).
 */
const INVALIDATING_ENTITIES = new Set<string>([
    'PriceList',
    'PriceListTranslation',
    'PriceListItem',
    'PriceListGroup',
    'PriceListGroupTranslation',
    'PriceListGroupMembership',
]);

/**
 * Subscribes to the events that affect pricelist lookup results and busts
 * the relevant cache tags.
 *
 * Two layers of invalidation:
 *   1. **Precise** (event-driven): access changes (per-customer / per-
 *      channel), customer-group membership, and standard variant price
 *      changes — keeps cache churn minimal for the common hot paths.
 *   2. **Broad** (TypeORM entity subscriber): any insert/update/remove on a
 *      pricelist entity (list, item, group, membership, translations) nukes
 *      the `pricelist:resolution` + `pricelist:computed` namespaces. This is
 *      the catch-all that makes create/update/delete/share/group-change/
 *      item-edit take effect immediately instead of lingering until the
 *      cache TTL. Over-invalidates (channel-agnostic) but admin writes are
 *      rare, so the trade-off is fine (PLAN-STAGE-2 §5.2 conservative
 *      stance, generalised to list lifecycle).
 *
 * Tag taxonomy (PLAN-STAGE-2 §Q3):
 *   - `pricelist:resolution` / `pricelist:channel:{id}` / `pricelist:customer:{id}`
 *   - `pricelist:computed` / `pricelist:variant:{id}` / `pricelist:list:{id}`
 */
@Injectable()
export class PriceListCacheInvalidatorService
    implements OnModuleInit, EntitySubscriberInterface
{
    constructor(
        private eventBus: EventBus,
        private cacheService: CacheService,
        private connection: TransactionalConnection,
    ) {}

    onModuleInit(): void {
        // Register self as a TypeORM subscriber so entity writes trigger the
        // broad invalidation. Pushing at runtime is read live by the
        // broadcaster on subsequent operations.
        this.connection.rawConnection.subscribers.push(this);

        this.eventBus.ofType(PriceListAccessChangeEvent).subscribe(async event => {
            try {
                await this.handleAccessChange(event);
            } catch (err) {
                Logger.error(
                    `PriceListAccessChangeEvent invalidation failed: ${(err as Error).message}`,
                    loggerCtx,
                );
            }
        });

        // Customer group membership change — invalidate per-customer
        // Layer-A entries for the affected customers.
        this.eventBus.ofType(CustomerGroupChangeEvent).subscribe(async event => {
            try {
                const customerIds = event.customers.map(c => String(c.id));
                const tags = customerIds.map(id => `pricelist:customer:${id}`);
                if (tags.length > 0) {
                    await this.cacheService.invalidateTags(tags);
                }
            } catch (err) {
                Logger.error(
                    `CustomerGroupChangeEvent invalidation failed: ${(err as Error).message}`,
                    loggerCtx,
                );
            }
        });

        // Standard product-variant price change — invalidate any computed
        // entry that used this variant as a PERCENTAGE cascade base.
        this.eventBus.ofType(ProductVariantPriceEvent).subscribe(async event => {
            try {
                const variantIds = new Set(
                    event.entity
                        .map(p => p.variant?.id)
                        .filter(
                            (id): id is import('@vendure/common/lib/shared-types').ID =>
                                id != null,
                        )
                        .map(id => String(id)),
                );
                if (variantIds.size === 0) return;
                await this.cacheService.invalidateTags(
                    [...variantIds].map(id => `pricelist:variant:${id}`),
                );
            } catch (err) {
                Logger.error(
                    `ProductVariantPriceEvent invalidation failed: ${(err as Error).message}`,
                    loggerCtx,
                );
            }
        });
    }

    // ─── TypeORM EntitySubscriberInterface (broad invalidation) ──────────

    afterInsert(event: InsertEvent<unknown>): void {
        this.invalidateForEntity(event.metadata.name);
    }
    afterUpdate(event: UpdateEvent<unknown>): void {
        this.invalidateForEntity(event.metadata.name);
    }
    afterRemove(event: RemoveEvent<unknown>): void {
        this.invalidateForEntity(event.metadata.name);
    }

    private invalidateForEntity(entityName: string): void {
        if (!INVALIDATING_ENTITIES.has(entityName)) return;
        // Subscriber hooks are sync; fire-and-forget the async invalidation.
        void this.cacheService
            .invalidateTags([RESOLUTION_NS, COMPUTED_NS])
            .catch(err =>
                Logger.error(
                    `Entity-change cache invalidation failed (${entityName}): ${(err as Error).message}`,
                    loggerCtx,
                ),
            );
    }

    // ─── Precise access-change invalidation ─────────────────────────────

    private async handleAccessChange(
        event: PriceListAccessChangeEvent,
    ): Promise<void> {
        const channelTag = `pricelist:channel:${event.channelId}`;
        switch (event.changeKind) {
            case 'everyone':
                await this.cacheService.invalidateTags([channelTag]);
                return;
            case 'customer':
                if (event.affectedCustomerIds.length === 0) return;
                await this.cacheService.invalidateTags(
                    event.affectedCustomerIds.map(id => `pricelist:customer:${id}`),
                );
                return;
            case 'customerGroup':
                await this.cacheService.invalidateTags([channelTag]);
                return;
        }
    }
}

import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import {
    CacheService,
    CustomerService,
    Injector,
    Logger,
    ProductVariant,
    RequestContext,
    RequestContextCacheService,
} from '@vendure/core';
import { createHash } from 'crypto';

import { PRICELIST_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { PluginInitOptions } from '../types';
import {
    ResolvedPrice,
    ResolvedPriceListGroup,
} from '../types/resolved-price';

const LAYER_B_NS = 'pricelist:computed';
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * Single public entry point of the Stage 2 lookup pipeline.
 * Consumed by Stage 3's `ProductVariantPriceCalculationStrategy`
 * wrapper. Everything else (strategies, predicates, caches) sits
 * behind this service.
 *
 * Three caching layers (PLAN-STAGE-2 §Q3):
 *   - Layer 0: per-request memoization via
 *     `RequestContextCacheService`. Avoids re-resolving the same
 *     customer when a single GraphQL query touches N variants.
 *   - Layer A: per-customer accessible lists. Owned by the
 *     resolution strategy itself (see
 *     `DefaultPriceListResolutionStrategy`).
 *   - Layer B: computed final price. Owned here, keyed on the
 *     resolved candidate-set hash + variant + currency + quantity.
 */
@Injectable()
export class PriceListLookupService implements OnApplicationBootstrap {
    constructor(
        private cacheService: CacheService,
        private requestCache: RequestContextCacheService,
        private customerService: CustomerService,
        private moduleRef: ModuleRef,
        @Inject(PRICELIST_PLUGIN_OPTIONS) private options: PluginInitOptions,
    ) {}

    /**
     * Plugin-defined strategies live on `PluginInitOptions`, outside
     * the NestJS DI container, so their optional `init(injector)`
     * hook isn't called automatically. We invoke it once per
     * strategy at bootstrap so they can grab their dependencies
     * (TransactionalConnection, CacheService, etc.) via the
     * injector.
     *
     * Idempotent: every `init` implementation we ship is safe to
     * re-run. Custom strategies should follow the same convention.
     */
    async onApplicationBootstrap(): Promise<void> {
        const injector = new Injector(this.moduleRef);
        const strategies = [
            this.options.resolutionStrategy,
            this.options.selectionStrategy,
            this.options.calculationStrategy,
            this.options.roundingStrategy,
            ...(this.options.additionalValidityPredicates ?? []),
        ];
        for (const s of strategies) {
            if (s && 'init' in s && typeof s.init === 'function') {
                try {
                    await s.init(injector);
                } catch (err) {
                    Logger.error(
                        `Strategy init failed for ${
                            (s as { constructor?: { name?: string } }).constructor?.name
                        }: ${(err as Error).message}`,
                        loggerCtx,
                    );
                }
            }
        }
    }

    /**
     * Resolves the effective price for `(variant, currency,
     * quantity)` against the merchandiser's configured pricelist
     * cascade. Returns `null` when no list applies — Stage 3's
     * wrapper then falls back to Vendure's standard pricing.
     *
     * @param quantity drives `stepQuantity` tier selection. For
     * catalog-browse contexts where no OrderLine exists, pass `1`.
     * For OrderLine recalc, pass `orderLine.quantity`.
     */
    async resolvePrice(
        ctx: RequestContext,
        variant: ProductVariant,
        currencyCode: CurrencyCode,
        quantity: number = 1,
    ): Promise<ResolvedPrice | null> {
        // Layer 0 — per-request memoization. Key includes `quantity`
        // because different qtys can hit different tiers.
        const reqKey = `pricelist:compute:${variant.id}:${currencyCode}:${quantity}`;
        const memoed = this.requestCache.get<ResolvedPrice | null>(ctx, reqKey);
        if (memoed !== undefined) return memoed;

        const customerId = await this.resolveCustomerIdForUser(ctx);
        const customerGroupIds = customerId
            ? await this.resolveCustomerGroupIds(ctx, customerId)
            : [];

        const groups = await this.options.resolutionStrategy!.resolve(
            ctx,
            customerId,
            customerGroupIds,
        );
        if (groups.length === 0) {
            this.requestCache.set(ctx, reqKey, null);
            return null;
        }

        // Layer B check. `ResolvedPrice` contains `ID` typed fields
        // (string|number) that don't strictly satisfy the
        // `JsonCompatible` constraint of `CacheService.get<T>`;
        // we cast through `any` because the runtime value IS JSON-
        // serialisable, but the structural constraint can't prove
        // it from the type definitions.
        const layerBKey = this.buildLayerBKey(ctx, groups, variant, currencyCode, quantity);
        const cached = (await this.cacheService.get(layerBKey)) as
            | ResolvedPrice
            | undefined;
        if (cached) {
            this.requestCache.set(ctx, reqKey, cached);
            return cached;
        }

        const resolved = await this.options.calculationStrategy!.calculate(
            ctx,
            variant,
            currencyCode,
            quantity,
            groups,
        );

        if (resolved !== null) {
            await this.cacheService.set(layerBKey, resolved as any, {
                ttl: this.computeTTL(groups),
                tags: [
                    LAYER_B_NS,
                    `pricelist:variant:${variant.id}`,
                    ...resolved.provenance.map(p => `pricelist:list:${p.listId}`),
                ],
            });
        }

        this.requestCache.set(ctx, reqKey, resolved);
        return resolved;
    }

    /**
     * Layer B cache key. The candidate list ids can be long, so the
     * full key string includes a SHA-1 of the sorted ids — fine for
     * cache (not crypto). Swappable behind this private method
     * (PLAN-STAGE-2 §5.3).
     */
    private buildLayerBKey(
        ctx: RequestContext,
        groups: ResolvedPriceListGroup[],
        variant: ProductVariant,
        currencyCode: CurrencyCode,
        quantity: number,
    ): string {
        const listIds = groups
            .flatMap(g => g.candidates.map(l => String(l.id)))
            .sort()
            .join(',');
        const hash = createHash('sha1').update(listIds).digest('hex').slice(0, 16);
        return `${LAYER_B_NS}:${ctx.channelId}:${hash}:${variant.id}:${currencyCode}:${quantity}`;
    }

    /**
     * TTL = soonest future date boundary among all candidates,
     * floored at the consumer-supplied safety cap. Same window the
     * resolution strategy's Layer-A cache uses — both layers
     * expire together when validity boundaries change.
     */
    private computeTTL(groups: ResolvedPriceListGroup[]): number {
        const cap = this.options.defaultCacheTtlMs ?? DEFAULT_TTL_MS;
        const now = Date.now();
        let soonest = now + cap;
        for (const g of groups) {
            for (const list of g.candidates) {
                for (const d of [list.startDate, list.endDate]) {
                    if (!d) continue;
                    const t = new Date(d).getTime();
                    if (t > now && t < soonest) soonest = t;
                }
            }
        }
        return soonest - now;
    }

    private async resolveCustomerIdForUser(
        ctx: RequestContext,
    ): Promise<ID | undefined> {
        if (!ctx.activeUserId) return undefined;
        try {
            const customer = await this.customerService.findOneByUserId(
                ctx,
                ctx.activeUserId,
            );
            return customer?.id;
        } catch (err) {
            Logger.warn(
                `Failed to resolve customer for user ${ctx.activeUserId}: ` +
                    `${(err as Error).message}`,
                loggerCtx,
            );
            return undefined;
        }
    }

    private async resolveCustomerGroupIds(
        ctx: RequestContext,
        customerId: ID,
    ): Promise<ID[]> {
        // CustomerService.getCustomerGroups is the typed, supported path —
        // avoids a raw `getRepository(ctx, 'Customer')` with `as any`
        // casts in the service layer.
        const groups = await this.customerService.getCustomerGroups(ctx, customerId);
        return groups.map(g => g.id);
    }
}

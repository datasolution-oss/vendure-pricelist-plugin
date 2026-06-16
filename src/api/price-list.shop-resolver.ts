import { Inject } from '@nestjs/common';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import {
    Ctx,
    ProductVariant,
    RequestContext,
    RequestContextCacheService,
} from '@vendure/core';

import { PRICELIST_PLUGIN_OPTIONS } from '../constants';
import { PriceListService } from '../services';
import {
    PricelistOriginalCacheEntry,
    pricelistOriginalCacheKey,
} from '../strategies/pricelist-original-cache';
import { PluginInitOptions } from '../types';

/**
 * Stage 3 §2.3 — Shop API strike-through fields on `ProductVariant`.
 *
 * Reads the per-request cache populated by
 * `PricelistVariantPriceCalculationStrategy` when the variant's price was
 * computed (applyChannelPriceAndTax runs before field resolvers, so the
 * entry is present whenever a pricelist applied). Returns null otherwise.
 */
@Resolver('ProductVariant')
export class PriceListShopResolver {
    constructor(
        private requestCache: RequestContextCacheService,
        private priceListService: PriceListService,
        @Inject(PRICELIST_PLUGIN_OPTIONS) private options: PluginInitOptions,
    ) {}

    @ResolveField()
    originalPrice(
        @Ctx() ctx: RequestContext,
        @Parent() variant: ProductVariant,
    ): number | null {
        return this.entry(ctx, variant)?.originalPrice ?? null;
    }

    @ResolveField()
    originalPriceWithTax(
        @Ctx() ctx: RequestContext,
        @Parent() variant: ProductVariant,
    ): number | null {
        const entry = this.entry(ctx, variant);
        if (!entry) return null;
        // Derive the gross original from the net original using the
        // variant's own tax ratio (a flat per-category rate, so the ratio
        // is identical for the original and adjusted prices). Avoids
        // re-running tax/zone logic.
        if (variant.price > 0 && variant.priceWithTax != null) {
            return Math.round(
                entry.originalPrice * (variant.priceWithTax / variant.price),
            );
        }
        return entry.originalPrice;
    }

    @ResolveField()
    async priceListBadge(
        @Ctx() ctx: RequestContext,
        @Parent() variant: ProductVariant,
    ): Promise<{ code: string; label: string } | null> {
        if (this.options.exposeBadgeOnShopApi === false) return null;
        const entry = this.entry(ctx, variant);
        if (!entry?.badge) return null;
        // Label = PriceList.name (translated). findOne is channel-scoped;
        // the list is in ctx.channel since it applied here.
        const list = await this.priceListService.findOne(ctx, entry.badge.listId);
        return { code: entry.badge.code, label: list?.name ?? entry.badge.code };
    }

    private entry(
        ctx: RequestContext,
        variant: ProductVariant,
    ): PricelistOriginalCacheEntry | undefined {
        return this.requestCache.get<PricelistOriginalCacheEntry>(
            ctx,
            pricelistOriginalCacheKey(variant.id, ctx.currencyCode),
        );
    }
}

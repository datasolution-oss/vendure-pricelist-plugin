import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Ctx, ProductVariant, RequestContext } from '@vendure/core';

import { PRICELIST_PLUGIN_OPTIONS } from '../constants';
import { PriceListService } from '../services';
import { ProductVariantPriceListService } from '../services/product-variant-price-list.service';
import { PluginInitOptions } from '../types';

import { Inject } from '@nestjs/common';
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
    private productVariantPriceListService: ProductVariantPriceListService,
    private priceListService: PriceListService,
    @Inject(PRICELIST_PLUGIN_OPTIONS) private options: PluginInitOptions
  ) {}

  @ResolveField()
  async originalPrice(@Ctx() ctx: RequestContext, @Parent() variant: ProductVariant): Promise<number | undefined> {
    return this.productVariantPriceListService.hydrateOriginalPrice(ctx, variant);
  }

  @ResolveField()
  async originalPriceWithTax(
    @Ctx() ctx: RequestContext,
    @Parent() variant: ProductVariant
  ): Promise<number | undefined> {
    return this.productVariantPriceListService.hydrateOriginalPriceWithTax(ctx, variant);
  }

  @ResolveField()
  async priceListBadge(
    @Ctx() ctx: RequestContext,
    @Parent() variant: ProductVariant
  ): Promise<{ code: string; label: string } | undefined> {
    if (this.options.exposeBadgeOnShopApi === false) return;
    const badge = await this.productVariantPriceListService.hydrateBadge(ctx, variant);

    if (!badge) return;

    const list = await this.priceListService.findOne(ctx, badge.listId);
    return { code: badge.code, label: list?.name ?? badge.code };
  }
}

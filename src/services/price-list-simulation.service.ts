import { Inject, Injectable } from '@nestjs/common';
import { CurrencyCode } from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import {
    CustomerService,
    ProductVariant,
    RequestContext,
    TaxRateService,
    TransactionalConnection,
    UserInputError,
    idsAreEqual,
} from '@vendure/core';

import { PRICELIST_PLUGIN_OPTIONS } from '../constants';
import {
    ResolvedPriceProvenanceEntry,
    ResolvedPriceSource,
} from '../types/resolved-price';
import { PluginInitOptions } from '../types';

/** Target of a simulation: a specific customer, a specific group, or anonymous. */
export interface SimulationTarget {
    customerId?: ID;
    customerGroupId?: ID;
}

export interface SimulatedVariantPrice {
    /** Standard (pre-pricelist) price, net minor units. Null if not priced. */
    standardPrice: number | null;
    standardPriceWithTax: number | null;
    /** Resolved cascade price, net minor units. Null when no list applies. */
    resolvedPrice: number | null;
    resolvedPriceWithTax: number | null;
    currencyCode: CurrencyCode;
    source: ResolvedPriceSource | null;
    provenance: ResolvedPriceProvenanceEntry[];
}

/**
 * Admin-only "what would this customer pay?" simulator. Reuses the SAME
 * resolution + calculation strategies as production pricing (so the result
 * matches the storefront exactly, including cheapest-in-group selection),
 * but lets the caller pass an arbitrary customer / group / anonymous target
 * instead of deriving it from the logged-in user.
 *
 * It deliberately bypasses `PriceListLookupService.resolvePrice` (which reads
 * the customer from `ctx` and applies the per-request / computed caches) and
 * calls `resolutionStrategy.resolve(...)` + `calculationStrategy.calculate(...)`
 * directly with the chosen customer/group.
 */
@Injectable()
export class PriceListSimulationService {
    constructor(
        private connection: TransactionalConnection,
        private customerService: CustomerService,
        private taxRateService: TaxRateService,
        @Inject(PRICELIST_PLUGIN_OPTIONS) private options: PluginInitOptions,
    ) {}

    async simulate(
        ctx: RequestContext,
        variantId: ID,
        currencyCode: CurrencyCode,
        quantity: number,
        target: SimulationTarget,
    ): Promise<SimulatedVariantPrice> {
        if (target.customerId != null && target.customerGroupId != null) {
            throw new UserInputError(
                'Provide either a customerId or a customerGroupId, not both.',
            );
        }
        if (!Number.isInteger(quantity) || quantity < 1) {
            throw new UserInputError('quantity must be a positive integer.');
        }

        // Load the variant with its raw prices + tax category, scoped to the
        // active channel. We filter productVariantPrices to the channel so the
        // calculation strategy's `standardPriceFor` reads the right base.
        const variant = await this.connection
            .getRepository(ctx, ProductVariant)
            .findOne({
                where: { id: variantId },
                relations: ['productVariantPrices', 'taxCategory', 'channels'],
            });
        if (
            !variant ||
            !variant.channels?.some(c => idsAreEqual(c.id, ctx.channelId))
        ) {
            throw new UserInputError(
                `ProductVariant ${variantId} not found in this channel`,
            );
        }
        variant.productVariantPrices = (variant.productVariantPrices ?? []).filter(
            p => idsAreEqual(p.channelId, ctx.channelId),
        );

        // Resolve the (customerId, customerGroupIds) the cascade will see.
        let customerId: ID | undefined;
        let customerGroupIds: ID[] = [];
        if (target.customerId != null) {
            customerId = target.customerId;
            const groups = await this.customerService.getCustomerGroups(
                ctx,
                customerId,
            );
            customerGroupIds = groups.map(g => g.id);
        } else if (target.customerGroupId != null) {
            customerGroupIds = [target.customerGroupId];
        }
        // else: anonymous — only `assignedToEveryone` lists apply.

        const groups = await this.options.resolutionStrategy!.resolve(
            ctx,
            customerId,
            customerGroupIds,
        );
        const resolved = groups.length
            ? await this.options.calculationStrategy!.calculate(
                  ctx,
                  variant,
                  currencyCode,
                  quantity,
                  groups,
              )
            : null;

        const standardStored =
            variant.productVariantPrices.find(p => p.currencyCode === currencyCode)
                ?.price ?? null;

        const taxRate = await this.taxRateService.getApplicableTaxRate(
            ctx,
            ctx.channel.defaultTaxZone,
            variant.taxCategory,
        );
        const split = (stored: number | null): [number | null, number | null] => {
            if (stored == null) return [null, null];
            // Stored value money mode depends on the channel: when prices
            // include tax the stored value is gross, otherwise net.
            return ctx.channel.pricesIncludeTax
                ? [Math.round(taxRate.netPriceOf(stored)), stored]
                : [stored, Math.round(taxRate.grossPriceOf(stored))];
        };

        const [standardPrice, standardPriceWithTax] = split(standardStored);
        const [resolvedPrice, resolvedPriceWithTax] = split(
            resolved ? resolved.value : null,
        );

        return {
            standardPrice,
            standardPriceWithTax,
            resolvedPrice,
            resolvedPriceWithTax,
            currencyCode,
            source: resolved?.source ?? null,
            provenance: resolved?.provenance ?? [],
        };
    }
}

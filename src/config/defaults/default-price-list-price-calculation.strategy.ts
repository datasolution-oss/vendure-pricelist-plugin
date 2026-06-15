import { CurrencyCode } from '@vendure/common/lib/generated-types';
import {
    Injector,
    Logger,
    ProductVariant,
    RequestContext,
} from '@vendure/core';

import { PRICELIST_PLUGIN_OPTIONS, loggerCtx } from '../../constants';
import { PriceListPriceCalculationStrategy } from '../price-list-price-calculation-strategy';
import { PriceListRoundingStrategy } from '../price-list-rounding-strategy';
import { PriceListSelectionStrategy } from '../price-list-selection-strategy';
import { PluginInitOptions } from '../../types';
import {
    ResolvedPrice,
    ResolvedPriceListGroup,
    ResolvedPriceProvenanceEntry,
} from '../../types/resolved-price';

/**
 * Reference implementation of the cascade. Override
 * `preProcessGroups` and / or `tryExternalPrice` to plug
 * enterprise-specific behaviour without touching the cascade body.
 *
 * Cascade semantics (PLAN-STAGE-2 §1.2.3):
 *   1. Apply `preProcessGroups` hook (default identity).
 *   2. Try `tryExternalPrice` (default null) — non-null
 *      short-circuits with `source = 'EXTERNAL'`.
 *   3. Walk groups in `priority ASC` order; for each, call the
 *      selection strategy. If it returns a `PriceListItem`, apply
 *      its contribution to `runningPrice` based on the parent
 *      list's `valueType` (Stage 1C: valueType lives on the list).
 *   4. After the last group, hand `runningPrice` to the rounding
 *      strategy. Return `ResolvedPrice`.
 *
 * Round-once is a documented decision: per-step rounding can drift
 * by a cent vs. end rounding on chained PERCENTAGE inputs — see
 * the counter-example in PLAN-STAGE-2 §2.4.
 */
export class DefaultPriceListPriceCalculationStrategy extends PriceListPriceCalculationStrategy {
    private selectionStrategy!: PriceListSelectionStrategy;
    private roundingStrategy!: PriceListRoundingStrategy;

    init(injector: Injector): void {
        const options = injector.get<PluginInitOptions>(PRICELIST_PLUGIN_OPTIONS);
        // The plugin's DI factory layer has guaranteed both strategies
        // are present (it merges in defaults when the consumer didn't
        // override). Cast to non-null to make that contract explicit.
        this.selectionStrategy = options.selectionStrategy!;
        this.roundingStrategy = options.roundingStrategy!;
    }

    async calculate(
        ctx: RequestContext,
        variant: ProductVariant,
        currencyCode: CurrencyCode,
        quantity: number,
        groups: ResolvedPriceListGroup[],
    ): Promise<ResolvedPrice | null> {
        // Phase A — preProcessGroups hook
        const effectiveGroups = await this.preProcessGroups(ctx, variant, groups);
        if (effectiveGroups.length === 0) return null;

        // Phase B — external short-circuit
        const external = await this.tryExternalPrice(
            ctx,
            variant,
            currencyCode,
            quantity,
        );
        if (external !== null) return external;

        // Phase C — cascade
        let runningPrice: number | null = null;
        const provenance: ResolvedPriceProvenanceEntry[] = [];

        for (const g of effectiveGroups) {
            const item = await this.selectionStrategy.selectWithinGroup(
                ctx,
                variant,
                currencyCode,
                quantity,
                g,
                runningPrice,
            );
            if (item === null) continue;

            // `valueType` lives on the parent list since Stage 1C —
            // selection helpers guarantee `item.priceList` is loaded.
            const listValueType = item.priceList.valueType;
            if (listValueType === 'ABSOLUTE') {
                runningPrice = item.value;
            } else if (listValueType === 'PERCENTAGE') {
                const base: number | null =
                    runningPrice ?? this.standardPriceFor(variant, currencyCode);
                if (base === null) {
                    Logger.warn(
                        `PERCENTAGE entry ${item.id} has no base price for ` +
                            `variant ${variant.id} / ${currencyCode}; cascade aborted.`,
                        loggerCtx,
                    );
                    return null;
                }
                runningPrice = base * (1 - item.value / 10000);
            }

            provenance.push({
                listId: item.priceListId,
                listCode: item.priceList.code,
                groupId: g.group.id,
                groupCode: g.group.code,
                itemId: item.id,
                stepQuantity: item.stepQuantity,
                valueType: listValueType,
                value: item.value,
            });
        }

        if (runningPrice === null) return null;

        return {
            value: this.roundingStrategy.round(runningPrice, currencyCode),
            currencyCode,
            provenance,
            source: 'CASCADE',
        };
    }

    private standardPriceFor(
        variant: ProductVariant,
        currencyCode: CurrencyCode,
    ): number | null {
        const match = variant.productVariantPrices?.find(
            p => p.currencyCode === currencyCode,
        );
        return match?.price ?? null;
    }
}

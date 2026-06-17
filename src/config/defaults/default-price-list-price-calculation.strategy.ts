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
 *   3. Walk groups in `priority DESC` order (highest priority first).
 *      For each group, ask the selection strategy:
 *        - PERCENTAGE → fold into a multiplier and continue (the
 *          base price isn't determined yet).
 *        - ABSOLUTE → that's the authoritative base; **stop**, lower-
 *          priority groups can't override it.
 *      If no ABSOLUTE is ever hit, the variant's standard catalog
 *      price plays that role.
 *   4. Final price = `basePrice * multiplier`, handed to the
 *      rounding strategy. Return `ResolvedPrice`.
 *
 * This is equivalent to the legacy ASC + last-write-wins cascade for
 * the price (multiplication is commutative; an absolute always
 * overrode the running price), but with two improvements:
 *   - Early exit on the first ABSOLUTE (`O(k)` where `k` is the rank
 *     of the highest-priority ABSOLUTE — vs. `O(n)` always).
 *   - Honest provenance: only the entries that actually contribute
 *     to the final price are recorded — no more entries for groups
 *     whose effect was wiped by a higher-priority override.
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

        // Phase C — cascade (highest priority first). The resolution
        // strategy hands groups in `priority ASC`; reverse here so the
        // first iteration is the most authoritative one.
        const groupsDesc = [...effectiveGroups].reverse();

        const standardPrice = this.standardPriceFor(variant, currencyCode);
        let basePrice: number | null = null;
        let multiplier = 1;
        const provenanceDesc: ResolvedPriceProvenanceEntry[] = [];

        for (const g of groupsDesc) {
            // `runningPrice` for the selection strategy = the price we
            // would yield if we stopped now (standard × accumulated
            // multiplier). Keeps `CheapestWinsSelectionStrategy` able
            // to compare ABSOLUTE vs PERCENTAGE candidates fairly.
            const tentativePrice = standardPrice !== null ? standardPrice * multiplier : null;

            const item = await this.selectionStrategy.selectWithinGroup(
                ctx,
                variant,
                currencyCode,
                quantity,
                g,
                tentativePrice,
            );
            if (item === null) continue;

            // `valueType` lives on the parent list since Stage 1C —
            // selection helpers guarantee `item.priceList` is loaded.
            const listValueType = item.priceList.valueType;
            provenanceDesc.push({
                listId: item.priceListId,
                listCode: item.priceList.code,
                groupId: g.group.id,
                groupCode: g.group.code,
                itemId: item.id,
                stepQuantity: item.stepQuantity,
                valueType: listValueType,
                value: item.value,
            });

            if (listValueType === 'ABSOLUTE') {
                basePrice = item.value;
                break; // an ABSOLUTE wins outright — no lower-priority group can override
            }
            if (listValueType === 'PERCENTAGE') {
                multiplier *= 1 - item.value / 10000;
            }
        }

        // No ABSOLUTE hit → percentages compound against the variant's
        // standard catalog price. If neither is available, the cascade
        // can't resolve a price.
        const finalBase = basePrice ?? standardPrice;
        if (finalBase === null) {
            if (provenanceDesc.length > 0) {
                Logger.warn(
                    `PERCENTAGE-only cascade has no base price for ` +
                        `variant ${variant.id} / ${currencyCode}; cascade aborted.`,
                    loggerCtx,
                );
            }
            return null;
        }
        if (provenanceDesc.length === 0) return null;

        // Convention: provenance is sorted lowest-priority first (so
        // consumers reading `provenance[length-1]` get the most
        // consumer-facing entry — the badge). Iteration above pushed
        // DESC, so reverse on the way out.
        const provenance = provenanceDesc.reverse();

        return {
            value: this.roundingStrategy.round(finalBase * multiplier, currencyCode),
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

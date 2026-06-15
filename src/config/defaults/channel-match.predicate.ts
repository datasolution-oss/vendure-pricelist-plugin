import { RequestContext, idsAreEqual } from '@vendure/core';

import { PriceList } from '../../entities/price-list.entity';
import { PriceListValidityPredicate } from '../price-list-validity-predicate';

/**
 * The list is visible on `ctx.channelId` via the
 * `price_list_channels_channel` M2M pivot. The default resolution
 * SQL already joins this pivot filtered by channel; this predicate
 * is a belt-and-suspenders check so a custom resolution strategy
 * that builds its candidate set differently still gets the channel
 * filter for free.
 *
 * Reads `list.channels` (the eager-loaded M2M relation). Custom
 * resolution strategies that don't load the relation should either
 * ensure it's loaded or skip this predicate.
 */
export class ChannelMatchPredicate implements PriceListValidityPredicate {
    test(ctx: RequestContext, list: PriceList, _nowUtc: Date): boolean {
        if (!list.channels) {
            // Relation not loaded — refuse the list rather than silently
            // pass; ensures bugs in custom strategies surface loudly.
            return false;
        }
        return list.channels.some(c => idsAreEqual(c.id, ctx.channelId));
    }
}

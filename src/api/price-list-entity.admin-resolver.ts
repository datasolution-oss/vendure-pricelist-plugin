import { Inject } from '@nestjs/common';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Ctx, ListQueryOptions, RequestContext } from '@vendure/core';

import { PRICELIST_PLUGIN_OPTIONS } from '../constants';
import { PriceList } from '../entities';
import { PriceListItemService } from '../services';
import { PluginInitOptions } from '../types';

const DEFAULT_PURGE_AFTER_MS = 60 * 60 * 1000; // 1h — mirrors plugin default

/**
 * Field resolver for the paginated `items` field on `PriceList`.
 * Trivial scalar/relation fields resolve directly from the entity loaded
 * by `PriceListService.findOne`/`findAll`.
 */
@Resolver('PriceList')
export class PriceListEntityResolver {
    constructor(
        private itemService: PriceListItemService,
        @Inject(PRICELIST_PLUGIN_OPTIONS) private options: PluginInitOptions,
    ) {}

    @ResolveField()
    async items(
        @Ctx() ctx: RequestContext,
        @Parent() priceList: PriceList,
        ...args: any[]
    ) {
        const options: ListQueryOptions<any> | undefined = args[0]?.options;
        return this.itemService.findByList(ctx, priceList.id, options);
    }

    /**
     * Computed `purgeAt`: when a pending-deletion list will be
     * hard-deleted by the cron task = `deletedAt + grace period`.
     * Null when the list isn't pending deletion, or when the purge
     * task is disabled (`purgePendingDeletionSchedule === null`) — in
     * that case it's never auto-purged.
     */
    @ResolveField()
    purgeAt(@Parent() priceList: PriceList): Date | null {
        if (!priceList.deletedAt) return null;
        if (this.options.purgePendingDeletionSchedule === null) return null;
        const graceMs =
            this.options.purgePendingDeletionAfterMs ?? DEFAULT_PURGE_AFTER_MS;
        return new Date(new Date(priceList.deletedAt).getTime() + graceMs);
    }
}

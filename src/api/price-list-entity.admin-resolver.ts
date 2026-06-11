import { Inject } from '@nestjs/common';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Channel, Ctx, ListQueryOptions, RequestContext } from '@vendure/core';

import { PRICELIST_PLUGIN_OPTIONS } from '../constants';
import { PriceList, PriceListGroup } from '../entities';
import { PriceListGroupService, PriceListItemService } from '../services';
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

/**
 * Field resolver for the singular `PriceListGroup.channel`. The group's
 * storage is a ChannelAware ManyToMany, but a group belongs to exactly one
 * channel, so the API exposes a single value. Uses the already-loaded
 * `channels` relation when present (detail / by-channel paths) and falls back
 * to a lookup for paths that don't load it (the paginated list query).
 */
@Resolver('PriceListGroup')
export class PriceListGroupEntityResolver {
    constructor(private groupService: PriceListGroupService) {}

    @ResolveField()
    async channel(
        @Ctx() ctx: RequestContext,
        @Parent() group: PriceListGroup,
    ): Promise<Channel | undefined> {
        if (group.channels?.length) {
            return group.channels[0];
        }
        return this.groupService.findChannelForGroup(ctx, group.id);
    }
}

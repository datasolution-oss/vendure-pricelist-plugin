import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Ctx, ListQueryOptions, RequestContext } from '@vendure/core';

import { PriceList } from '../entities';
import { PriceListItemService } from '../services';

/**
 * Field resolver for the paginated `items` field on `PriceList`.
 * Trivial scalar/relation fields resolve directly from the entity loaded
 * by `PriceListService.findOne`/`findAll`.
 */
@Resolver('PriceList')
export class PriceListEntityResolver {
    constructor(private itemService: PriceListItemService) {}

    @ResolveField()
    async items(
        @Ctx() ctx: RequestContext,
        @Parent() priceList: PriceList,
        ...args: any[]
    ) {
        const options: ListQueryOptions<any> | undefined = args[0]?.options;
        return this.itemService.findByList(ctx, priceList.id, options);
    }
}

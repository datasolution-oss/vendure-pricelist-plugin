import { PriceListAdminResolver } from './price-list.admin-resolver';
import {
    PriceListEntityResolver,
    PriceListGroupEntityResolver,
} from './price-list-entity.admin-resolver';
import { PriceListGroupAdminResolver } from './price-list-group.admin-resolver';
import { PriceListItemAdminResolver } from './price-list-item.admin-resolver';
import { PriceListShopResolver } from './price-list.shop-resolver';

export { adminApiExtensions } from './admin-api.schema';
export { shopApiExtensions } from './shop-api.schema';

export const ALL_RESOLVERS = [
    PriceListAdminResolver,
    PriceListItemAdminResolver,
    PriceListGroupAdminResolver,
    PriceListEntityResolver,
    PriceListGroupEntityResolver,
];

export const ALL_SHOP_RESOLVERS = [PriceListShopResolver];

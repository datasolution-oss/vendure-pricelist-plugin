import { PriceListAdminResolver } from './price-list.admin-resolver';
import {
    PriceListEntityResolver,
    PriceListGroupEntityResolver,
} from './price-list-entity.admin-resolver';
import { PriceListGroupAdminResolver } from './price-list-group.admin-resolver';
import { PriceListItemAdminResolver } from './price-list-item.admin-resolver';

export { adminApiExtensions } from './admin-api.schema';

export const ALL_RESOLVERS = [
    PriceListAdminResolver,
    PriceListItemAdminResolver,
    PriceListGroupAdminResolver,
    PriceListEntityResolver,
    PriceListGroupEntityResolver,
];

import { PluginCommonModule, Type, VendurePlugin } from '@vendure/core';

import { adminApiExtensions, ALL_RESOLVERS } from './api';
import { PRICELIST_PLUGIN_OPTIONS } from './constants';
import { ALL_ENTITIES } from './entities';
import { priceListGroupPermission, priceListPermission } from './permissions';
import { ALL_SERVICES } from './services';
import { PluginInitOptions } from './types';

@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [
        ...ALL_SERVICES,
        { provide: PRICELIST_PLUGIN_OPTIONS, useFactory: () => PricelistPlugin.options },
    ],
    entities: ALL_ENTITIES,
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: ALL_RESOLVERS,
    },
    configuration: config => {
        config.authOptions.customPermissions.push(
            priceListPermission,
            priceListGroupPermission,
        );
        return config;
    },
    dashboard: './dashboard/index.tsx',
    compatibility: '^3.6.0',
})
export class PricelistPlugin {
    static options: PluginInitOptions = {};

    static init(options: PluginInitOptions = {}): Type<PricelistPlugin> {
        this.options = options;
        return PricelistPlugin;
    }
}

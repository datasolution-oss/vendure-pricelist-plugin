import { PluginCommonModule, Type, VendurePlugin } from '@vendure/core';

import { PRICELIST_PLUGIN_OPTIONS } from './constants';
import { PluginInitOptions } from './types';

@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [{ provide: PRICELIST_PLUGIN_OPTIONS, useFactory: () => PricelistPlugin.options }],
    configuration: config => {
        // Plugin-specific configuration
        // such as custom fields, custom permissions,
        // strategies etc. can be configured here by
        // modifying the `config` object.
        return config;
    },
    compatibility: '^3.0.0',
})
export class PricelistPlugin {
    static options: PluginInitOptions;

    static init(options: PluginInitOptions): Type<PricelistPlugin> {
        this.options = options;
        return PricelistPlugin;
    }
}

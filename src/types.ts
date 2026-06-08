/**
 * @description
 * Init options for the Pricelist plugin. All fields optional with sensible
 * defaults applied in `PricelistPlugin.init()`.
 *
 * Stage 1 ships an empty options shape; Stage 2 will add strategy slots
 * (resolution, selection, calculation, rounding), `killSwitchPerChannel`,
 * and `defaultCacheTtlMs`.
 */
export interface PluginInitOptions {
    /**
     * Reserved — populated by Stage 2.
     */
    [key: string]: unknown;
}

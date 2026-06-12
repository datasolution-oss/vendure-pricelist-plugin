export const PRICELIST_PLUGIN_OPTIONS = Symbol('PRICELIST_PLUGIN_OPTIONS');
export const loggerCtx = 'PricelistPlugin';

/**
 * Code of the auto-created default group for each channel. Used by the
 * channel-creation hook and by PriceListService when resolving the group
 * for a list created without an explicit groupId.
 */
export const DEFAULT_GROUP_CODE = 'default';

/**
 * Error code returned by services when an edit is attempted on a pricelist
 * from a channel that is not its origin. Surfaced to the dashboard via
 * GraphQL error extensions for client-side message localisation.
 */
export const ERR_PRICELIST_READONLY_NON_ORIGIN_CHANNEL =
    'PRICELIST_READONLY_NON_ORIGIN_CHANNEL';

/**
 * Error code returned when share-to-channel is invoked with a group that
 * does not belong to the target channel (cross-channel group consistency).
 */
export const ERR_PRICELIST_GROUP_CHANNEL_MISMATCH =
    'PRICELIST_GROUP_CHANNEL_MISMATCH';

/**
 * Error code returned by PriceListGroupService.delete() when called on a
 * group that is the default for one or more channels.
 */
export const ERR_PRICELIST_GROUP_DEFAULT_NOT_DELETABLE =
    'PRICELIST_GROUP_DEFAULT_NOT_DELETABLE';

/**
 * Error code returned when a channel-local action (group binding, access
 * management) targets a channel the pricelist is not shared to.
 */
export const ERR_PRICELIST_NOT_SHARED_TO_CHANNEL =
    'PRICELIST_NOT_SHARED_TO_CHANNEL';

/**
 * Error code returned by `assignPriceListToChannel` when the target channel
 * is already in the PriceList's `channels` relation.
 */
export const ERR_PRICELIST_ALREADY_SHARED_TO_CHANNEL =
    'PRICELIST_ALREADY_SHARED_TO_CHANNEL';

/**
 * Error code returned by `removePriceListFromChannel` when the caller
 * attempts to remove the list's origin channel. Delete the list instead.
 */
export const ERR_PRICELIST_ORIGIN_CHANNEL_NOT_REMOVABLE =
    'PRICELIST_ORIGIN_CHANNEL_NOT_REMOVABLE';

/**
 * Error code returned by `addPriceListItem` when an item for
 * (variant, currency, stepQuantity) already exists in the list — the
 * UNIQUE constraint on the row.
 */
export const ERR_PRICELIST_ITEM_DUPLICATE = 'PRICELIST_ITEM_DUPLICATE';

/**
 * Error code returned by `savePriceListVariantPivot` when the incoming
 * payload carries two rows with the same (currencyCode, stepQuantity).
 */
export const ERR_PRICELIST_PIVOT_DUPLICATE_CELL =
    'PRICELIST_PIVOT_DUPLICATE_CELL';

/** Error code: `stepQuantity` is not a positive integer. */
export const ERR_PRICELIST_PIVOT_INVALID_STEP_QUANTITY =
    'PRICELIST_PIVOT_INVALID_STEP_QUANTITY';

/** Error code: `value` is not a non-negative integer. */
export const ERR_PRICELIST_PIVOT_INVALID_VALUE = 'PRICELIST_PIVOT_INVALID_VALUE';

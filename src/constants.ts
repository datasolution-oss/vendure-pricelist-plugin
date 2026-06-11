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

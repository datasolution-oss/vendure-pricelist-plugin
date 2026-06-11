import { CrudPermissionDefinition, PermissionDefinition } from '@vendure/core';

/**
 * CRUD permissions for PriceList — produces ReadPriceList, CreatePriceList,
 * UpdatePriceList, DeletePriceList.
 *
 * `UpdatePriceList` / `DeletePriceList` gate **content** mutations (code,
 * prices/items, validity window, valueType, priority). These are
 * additionally origin-channel-guarded at the service layer: a user
 * holding `UpdatePriceList` on channel B can edit lists whose origin is
 * B, but NOT lists shared into B from elsewhere (PLAN-STAGE-1F §5).
 */
export const priceListPermission = new CrudPermissionDefinition('PriceList');

/**
 * CRUD permissions for PriceListGroup — produces ReadPriceListGroup,
 * CreatePriceListGroup, UpdatePriceListGroup, DeletePriceListGroup.
 */
export const priceListGroupPermission = new CrudPermissionDefinition('PriceListGroup');

/**
 * Targeted, channel-local permissions (PLAN-STAGE-1F §4). Single
 * definitions — they surface individually in the dashboard role form
 * (`roles/new`) so a role can grant exactly one capability without the
 * full CRUD bundle. Unlike content edits these are NOT origin-guarded:
 * they apply to the channel the actor is in (the list must be shared
 * there), enabling a single-channel admin to organise / scope a list
 * shared from another channel without touching its content.
 */

/** Share or un-share a PriceList to/from a channel. */
export const sharePriceListPermission = new PermissionDefinition({
    name: 'SharePriceList',
    description: 'Allows sharing/un-sharing a PriceList to/from channels',
});

/** Bind a PriceList to a group within a channel. */
export const assignPriceListGroupPermission = new PermissionDefinition({
    name: 'AssignPriceListGroup',
    description: 'Allows binding a PriceList to a group within a channel',
});

/** Manage customer / customer-group access for a PriceList on a channel. */
export const managePriceListAccessPermission = new PermissionDefinition({
    name: 'ManagePriceListAccess',
    description:
        'Allows managing customer and customer-group access for a PriceList on a channel',
});

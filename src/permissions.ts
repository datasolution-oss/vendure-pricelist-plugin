import { CrudPermissionDefinition } from '@vendure/core';

/**
 * CRUD permissions for PriceList — produces ReadPriceList, CreatePriceList,
 * UpdatePriceList, DeletePriceList.
 *
 * Note: channel scoping for the "shared list read-only on non-origin channel"
 * rule (PLAN-STAGE-1 §1.1 Q5) is enforced at the service layer, NOT here.
 * A user holding `UpdatePriceList` on channel B can edit lists whose origin
 * is B, but NOT lists shared into B from elsewhere.
 */
export const priceListPermission = new CrudPermissionDefinition('PriceList');

/**
 * CRUD permissions for PriceListGroup — produces ReadPriceListGroup,
 * CreatePriceListGroup, UpdatePriceListGroup, DeletePriceListGroup.
 */
export const priceListGroupPermission = new CrudPermissionDefinition('PriceListGroup');

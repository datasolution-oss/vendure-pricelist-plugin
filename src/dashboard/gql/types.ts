/**
 * Local TypeScript types for the dashboard queries.
 *
 * NOTE: replace with gql.tada generated types once the dashboard codegen
 * step has run against the live schema.
 */

export type PriceListValueType = 'ABSOLUTE' | 'PERCENTAGE';

export interface PriceListListItem {
    id: string;
    code: string;
    name: string;
    valueType: PriceListValueType;
    timezone: string;
    priority: number;
    enabled: boolean;
    startDate: string | null;
    endDate: string | null;
    originChannel: { id: string; code: string };
    channels: Array<{ id: string; code: string }>;
    createdAt: string;
    updatedAt: string;
}

export interface PriceListListResult {
    priceLists: {
        items: PriceListListItem[];
        totalItems: number;
    };
}

export interface PriceListItemDetail {
    id: string;
    currencyCode: string;
    value: number;
    stepQuantity: number;
    productVariant: { id: string; name: string; sku: string };
}

export interface PriceListGroupMembershipItem {
    id: string;
    group: {
        id: string;
        code: string;
        name: string;
        channel: { id: string; code: string };
    };
}

export interface PriceListAssignedCustomer {
    id: string;
    emailAddress: string;
    firstName: string | null;
    lastName: string | null;
}

export interface PriceListAssignedCustomerGroup {
    id: string;
    name: string;
}

export interface PriceListTranslationItem {
    id: string;
    languageCode: string;
    name: string;
    description: string | null;
}

export interface PriceListOriginChannel {
    id: string;
    code: string;
    availableCurrencyCodes: string[];
    defaultCurrencyCode: string;
}

export interface PriceListDetail
    extends Omit<PriceListListItem, 'originChannel'> {
    description: string | null;
    originChannel: PriceListOriginChannel;
    groupMemberships: PriceListGroupMembershipItem[];
    /**
     * `assignedCustomers` / `assignedCustomerGroups` are NOT inlined here —
     * loaded via the paginated `priceListAssignedCustomers` /
     * `priceListAssignedCustomerGroups` queries instead. Items are also
     * paginated via the dedicated grid query.
     */
    assignedToEveryone: boolean;
    translations: PriceListTranslationItem[];
}

export interface PriceListAssignedCustomersResult {
    priceListAssignedCustomers: {
        items: PriceListAssignedCustomer[];
        totalItems: number;
    };
}

export interface PriceListAssignedCustomerGroupsResult {
    priceListAssignedCustomerGroups: {
        items: PriceListAssignedCustomerGroup[];
        totalItems: number;
    };
}

export interface PriceListItemsResult {
    priceList: {
        id: string;
        items: {
            items: PriceListItemDetail[];
            totalItems: number;
        };
    } | null;
}

export interface PriceListDetailResult {
    priceList: PriceListDetail | null;
}

export interface PriceListGroupTranslationItem {
    id: string;
    languageCode: string;
    name: string;
}

export interface PriceListGroupListItem {
    id: string;
    code: string;
    name: string;
    priority: number;
    isDefault: boolean;
    channel: { id: string; code: string };
    createdAt: string;
    updatedAt: string;
}

export interface PriceListGroupDetail extends PriceListGroupListItem {
    translations: PriceListGroupTranslationItem[];
}

export interface PriceListGroupListResult {
    priceListGroups: {
        items: PriceListGroupListItem[];
        totalItems: number;
    };
}

export interface PriceListGroupDetailResult {
    priceListGroup: PriceListGroupDetail | null;
}

export interface PriceListGroupByChannelItem {
    id: string;
    code: string;
    name: string;
    priority: number;
    isDefault: boolean;
}

export interface PriceListGroupsByChannelResult {
    priceListGroupsByChannel: PriceListGroupByChannelItem[];
}

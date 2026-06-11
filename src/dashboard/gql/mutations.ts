import { graphql } from '@/vdb/graphql/graphql.js';

// === PriceList CRUD ===

export const createPriceListMutation = graphql(/* GraphQL */ `
    mutation CreatePriceList($input: CreatePriceListInput!) {
        createPriceList(input: $input) {
            id
            code
            name
        }
    }
`);

export const updatePriceListMutation = graphql(/* GraphQL */ `
    mutation UpdatePriceList($input: UpdatePriceListInput!) {
        updatePriceList(input: $input) {
            id
            code
            name
        }
    }
`);

export const deletePriceListMutation = graphql(/* GraphQL */ `
    mutation DeletePriceList($id: ID!) {
        deletePriceList(id: $id) {
            result
            message
        }
    }
`);

/**
 * Cancel a pending deletion (Stage 1E). Clears `deletedAt` so the
 * `pricelist-purge-pending-deletion` cron task stops considering the
 * pricelist a purge candidate.
 */
export const restorePriceListMutation = graphql(/* GraphQL */ `
    mutation RestorePriceList($id: ID!) {
        restorePriceList(id: $id) {
            id
            deletedAt
        }
    }
`);

// === Items ===

export const addPriceListItemMutation = graphql(/* GraphQL */ `
    mutation AddPriceListItem($input: CreatePriceListItemInput!) {
        addPriceListItem(input: $input) {
            id
            currencyCode
            value
            stepQuantity
        }
    }
`);

export const updatePriceListItemMutation = graphql(/* GraphQL */ `
    mutation UpdatePriceListItem($input: UpdatePriceListItemInput!) {
        updatePriceListItem(input: $input) {
            id
            value
            stepQuantity
        }
    }
`);

export const removePriceListItemMutation = graphql(/* GraphQL */ `
    mutation RemovePriceListItem($id: ID!) {
        removePriceListItem(id: $id) {
            result
            message
        }
    }
`);

/**
 * Replace the entire pivot for one (priceList, variant) atomically.
 * Mirrors the Stage 1D backend mutation `savePriceListVariantPivot`.
 */
export const savePriceListVariantPivotMutation = graphql(/* GraphQL */ `
    mutation SavePriceListVariantPivot($input: SavePriceListVariantPivotInput!) {
        savePriceListVariantPivot(input: $input) {
            id
            currencyCode
            stepQuantity
            value
        }
    }
`);

// === Channel sharing ===

export const assignPriceListToChannelMutation = graphql(/* GraphQL */ `
    mutation AssignPriceListToChannel($input: AssignPriceListToChannelInput!) {
        assignPriceListToChannel(input: $input) {
            id
            channels {
                id
                code
            }
        }
    }
`);

export const removePriceListFromChannelMutation = graphql(/* GraphQL */ `
    mutation RemovePriceListFromChannel($priceListId: ID!, $channelId: ID!) {
        removePriceListFromChannel(priceListId: $priceListId, channelId: $channelId) {
            id
            channels {
                id
                code
            }
        }
    }
`);

/**
 * Reassign which group a pricelist belongs to on a channel. Returns
 * refreshed groupMemberships so the Channel memberships table on the
 * detail page updates in place.
 */
export const changePriceListGroupMutation = graphql(/* GraphQL */ `
    mutation ChangePriceListGroup($priceListId: ID!, $channelId: ID!, $groupId: ID!) {
        changePriceListGroup(priceListId: $priceListId, channelId: $channelId, groupId: $groupId) {
            id
            groupMemberships {
                id
                channel {
                    id
                    code
                }
                group {
                    id
                    code
                    name
                }
            }
        }
    }
`);

// === Customer access ===

/**
 * Access is per (PriceList, Channel): every access mutation now takes a
 * `channelId` (the active channel) and returns the affected
 * `PriceListChannelAccess` row. The dashboard refetches the paginated
 * `priceListAssignedCustomers` / `priceListAssignedCustomerGroups`
 * queries (also channel-scoped) to pick up customer/group changes.
 */
export const setPriceListAssignedToEveryoneMutation = graphql(/* GraphQL */ `
    mutation SetPriceListAssignedToEveryone($priceListId: ID!, $channelId: ID!, $assigned: Boolean!) {
        setPriceListAssignedToEveryone(priceListId: $priceListId, channelId: $channelId, assigned: $assigned) {
            id
            assignedToEveryone
        }
    }
`);

export const addCustomersToPriceListMutation = graphql(/* GraphQL */ `
    mutation AddCustomersToPriceList($priceListId: ID!, $channelId: ID!, $customerIds: [ID!]!) {
        addCustomersToPriceList(priceListId: $priceListId, channelId: $channelId, customerIds: $customerIds) {
            id
            assignedToEveryone
        }
    }
`);

export const removeCustomersFromPriceListMutation = graphql(/* GraphQL */ `
    mutation RemoveCustomersFromPriceList($priceListId: ID!, $channelId: ID!, $customerIds: [ID!]!) {
        removeCustomersFromPriceList(priceListId: $priceListId, channelId: $channelId, customerIds: $customerIds) {
            id
            assignedToEveryone
        }
    }
`);

export const addCustomerGroupsToPriceListMutation = graphql(/* GraphQL */ `
    mutation AddCustomerGroupsToPriceList($priceListId: ID!, $channelId: ID!, $customerGroupIds: [ID!]!) {
        addCustomerGroupsToPriceList(priceListId: $priceListId, channelId: $channelId, customerGroupIds: $customerGroupIds) {
            id
            assignedToEveryone
        }
    }
`);

export const removeCustomerGroupsFromPriceListMutation = graphql(/* GraphQL */ `
    mutation RemoveCustomerGroupsFromPriceList($priceListId: ID!, $channelId: ID!, $customerGroupIds: [ID!]!) {
        removeCustomerGroupsFromPriceList(priceListId: $priceListId, channelId: $channelId, customerGroupIds: $customerGroupIds) {
            id
            assignedToEveryone
        }
    }
`);

// === PriceListGroup CRUD ===

export const createPriceListGroupMutation = graphql(/* GraphQL */ `
    mutation CreatePriceListGroup($input: CreatePriceListGroupInput!) {
        createPriceListGroup(input: $input) {
            id
            code
            name
        }
    }
`);

export const updatePriceListGroupMutation = graphql(/* GraphQL */ `
    mutation UpdatePriceListGroup($input: UpdatePriceListGroupInput!) {
        updatePriceListGroup(input: $input) {
            id
            code
            name
            priority
        }
    }
`);

export const deletePriceListGroupMutation = graphql(/* GraphQL */ `
    mutation DeletePriceListGroup($id: ID!) {
        deletePriceListGroup(id: $id) {
            result
            message
        }
    }
`);

export const setDefaultPriceListGroupMutation = graphql(/* GraphQL */ `
    mutation SetDefaultPriceListGroup($channelId: ID!, $groupId: ID!) {
        setDefaultPriceListGroup(channelId: $channelId, groupId: $groupId) {
            id
            code
        }
    }
`);

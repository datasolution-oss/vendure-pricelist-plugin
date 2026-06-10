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

// === Customer access ===

export const setPriceListAssignedToEveryoneMutation = graphql(/* GraphQL */ `
    mutation SetPriceListAssignedToEveryone($priceListId: ID!, $assigned: Boolean!) {
        setPriceListAssignedToEveryone(priceListId: $priceListId, assigned: $assigned) {
            id
            assignedToEveryone
        }
    }
`);

/**
 * NOTE: the inline `assignedCustomers` / `assignedCustomerGroups`
 * selections were dropped in Stage 1C — those relations are no longer
 * exposed on `PriceList` (they're loaded via the paginated queries
 * `priceListAssignedCustomers` / `priceListAssignedCustomerGroups`).
 * The mutations still return the `PriceList` to confirm the change
 * applied; the dashboard refetches the relevant paginated query to
 * pick up the new state.
 */
export const addCustomersToPriceListMutation = graphql(/* GraphQL */ `
    mutation AddCustomersToPriceList($priceListId: ID!, $customerIds: [ID!]!) {
        addCustomersToPriceList(priceListId: $priceListId, customerIds: $customerIds) {
            id
        }
    }
`);

export const removeCustomersFromPriceListMutation = graphql(/* GraphQL */ `
    mutation RemoveCustomersFromPriceList($priceListId: ID!, $customerIds: [ID!]!) {
        removeCustomersFromPriceList(priceListId: $priceListId, customerIds: $customerIds) {
            id
        }
    }
`);

export const addCustomerGroupsToPriceListMutation = graphql(/* GraphQL */ `
    mutation AddCustomerGroupsToPriceList($priceListId: ID!, $customerGroupIds: [ID!]!) {
        addCustomerGroupsToPriceList(priceListId: $priceListId, customerGroupIds: $customerGroupIds) {
            id
        }
    }
`);

export const removeCustomerGroupsFromPriceListMutation = graphql(/* GraphQL */ `
    mutation RemoveCustomerGroupsFromPriceList($priceListId: ID!, $customerGroupIds: [ID!]!) {
        removeCustomerGroupsFromPriceList(priceListId: $priceListId, customerGroupIds: $customerGroupIds) {
            id
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
            isDefault
        }
    }
`);

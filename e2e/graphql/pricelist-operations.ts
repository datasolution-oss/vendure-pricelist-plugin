import gql from 'graphql-tag';

// All admin-API operations against the pricelist plugin live here. The
// vanilla `graphql-env-admin.d.ts` introspection snapshot doesn't include
// the plugin types, so these are plain `gql` documents — callers treat
// the results as `any`.

export const ACTIVE_CHANNEL = gql`
    query GetActiveChannel {
        activeChannel {
            id
            code
            token
            defaultCurrencyCode
            defaultLanguageCode
            defaultTaxZone {
                id
            }
            defaultShippingZone {
                id
            }
            pricesIncludeTax
        }
    }
`;

export const CREATE_PRICE_LIST = gql`
    mutation CreatePriceList($input: CreatePriceListInput!) {
        createPriceList(input: $input) {
            id
            code
            name
            description
            valueType
            timezone
            priority
            enabled
            originChannel {
                id
                code
            }
            channels {
                id
                code
            }
            groupMemberships {
                id
                channel {
                    id
                }
                group {
                    id
                    code
                    name
                }
            }
        }
    }
`;

export const UPDATE_PRICE_LIST = gql`
    mutation UpdatePriceList($input: UpdatePriceListInput!) {
        updatePriceList(input: $input) {
            id
            code
            priority
            enabled
            timezone
            name
            description
        }
    }
`;

export const DELETE_PRICE_LIST = gql`
    mutation DeletePriceList($id: ID!) {
        deletePriceList(id: $id) {
            result
            message
        }
    }
`;

export const RESTORE_PRICE_LIST = gql`
    mutation RestorePriceList($id: ID!) {
        restorePriceList(id: $id) {
            id
            deletedAt
        }
    }
`;

export const PRICE_LIST = gql`
    query GetPriceList($id: ID!) {
        priceList(id: $id) {
            id
            code
            name
            valueType
            timezone
            priority
            enabled
            deletedAt
            purgeAt
            originChannel {
                id
            }
            channels {
                id
                code
            }
            items {
                items {
                    id
                    productVariant {
                        id
                    }
                    currencyCode
                    value
                    stepQuantity
                }
                totalItems
            }
            groupMemberships {
                id
                channel {
                    id
                }
                group {
                    id
                    code
                    name
                }
            }
        }
    }
`;

export const PRICE_LISTS = gql`
    query GetPriceLists($options: PriceListListOptions) {
        priceLists(options: $options) {
            items {
                id
                code
                deletedAt
            }
            totalItems
        }
    }
`;

export const SAVE_PIVOT = gql`
    mutation SavePivot($input: SavePriceListVariantPivotInput!) {
        savePriceListVariantPivot(input: $input) {
            id
            currencyCode
            stepQuantity
            value
            productVariant {
                id
            }
        }
    }
`;

export const ADD_ITEM = gql`
    mutation AddItem($input: CreatePriceListItemInput!) {
        addPriceListItem(input: $input) {
            id
        }
    }
`;

export const UPDATE_ITEM = gql`
    mutation UpdateItem($input: UpdatePriceListItemInput!) {
        updatePriceListItem(input: $input) {
            id
            value
            stepQuantity
        }
    }
`;

export const REMOVE_ITEM = gql`
    mutation RemoveItem($id: ID!) {
        removePriceListItem(id: $id) {
            result
            message
        }
    }
`;

export const VARIANT_ITEMS = gql`
    query VariantItems($priceListId: ID!, $productVariantId: ID!) {
        priceListVariantItems(
            priceListId: $priceListId
            productVariantId: $productVariantId
        ) {
            id
            currencyCode
            stepQuantity
            value
        }
    }
`;

export const VARIANT_SUMMARIES = gql`
    query VariantSummaries($priceListId: ID!, $options: PriceListVariantSummaryListOptions) {
        priceListVariantSummaries(priceListId: $priceListId, options: $options) {
            items {
                id
                productVariant {
                    id
                }
                currencyCount
                tierCount
                cellCount
                cells {
                    currencyCode
                    stepQuantity
                    value
                }
            }
            totalItems
        }
    }
`;

export const CREATE_GROUP = gql`
    mutation CreatePriceListGroup($input: CreatePriceListGroupInput!) {
        createPriceListGroup(input: $input) {
            id
            code
            name
            priority
            channel {
                id
                code
            }
        }
    }
`;

export const DELETE_GROUP = gql`
    mutation DeletePriceListGroup($id: ID!) {
        deletePriceListGroup(id: $id) {
            result
            message
        }
    }
`;

export const UPDATE_GROUP = gql`
    mutation UpdatePriceListGroup($input: UpdatePriceListGroupInput!) {
        updatePriceListGroup(input: $input) {
            id
            code
            name
            priority
        }
    }
`;

export const PRICE_LIST_GROUP = gql`
    query PriceListGroup($id: ID!) {
        priceListGroup(id: $id) {
            id
            code
            name
            priority
            channel {
                id
            }
        }
    }
`;

export const GROUPS_BY_CHANNEL = gql`
    query GroupsByChannel($channelId: ID!) {
        priceListGroupsByChannel(channelId: $channelId) {
            id
            code
            name
            channel {
                id
            }
        }
    }
`;

export const DEFAULT_GROUP = gql`
    query DefaultGroup($channelId: ID!) {
        priceListDefaultGroup(channelId: $channelId) {
            id
            code
            name
            channel {
                id
            }
        }
    }
`;

export const SET_DEFAULT_GROUP = gql`
    mutation SetDefaultGroup($channelId: ID!, $groupId: ID!) {
        setDefaultPriceListGroup(channelId: $channelId, groupId: $groupId) {
            id
            code
        }
    }
`;

export const CHANGE_GROUP = gql`
    mutation ChangeGroup($priceListId: ID!, $channelId: ID!, $groupId: ID!) {
        changePriceListGroup(
            priceListId: $priceListId
            channelId: $channelId
            groupId: $groupId
        ) {
            id
            groupMemberships {
                channel {
                    id
                }
                group {
                    id
                }
            }
        }
    }
`;

export const PRICE_LISTS_BY_GROUP = gql`
    query PriceListsByGroup($groupId: ID!) {
        priceListsByGroup(groupId: $groupId) {
            items {
                id
                code
            }
            totalItems
        }
    }
`;

export const ASSIGN_TO_CHANNEL = gql`
    mutation AssignToChannel($input: AssignPriceListToChannelInput!) {
        assignPriceListToChannel(input: $input) {
            id
            channels {
                id
            }
            groupMemberships {
                channel {
                    id
                }
                group {
                    id
                }
            }
        }
    }
`;

export const REMOVE_FROM_CHANNEL = gql`
    mutation RemoveFromChannel($priceListId: ID!, $channelId: ID!) {
        removePriceListFromChannel(priceListId: $priceListId, channelId: $channelId) {
            id
            channels {
                id
            }
        }
    }
`;

export const SET_EVERYONE = gql`
    mutation SetEveryone($priceListId: ID!, $channelId: ID!, $assigned: Boolean!) {
        setPriceListAssignedToEveryone(
            priceListId: $priceListId
            channelId: $channelId
            assigned: $assigned
        ) {
            id
            assignedToEveryone
            channel {
                id
            }
        }
    }
`;

export const ADD_CUSTOMERS = gql`
    mutation AddCustomers($priceListId: ID!, $channelId: ID!, $customerIds: [ID!]!) {
        addCustomersToPriceList(
            priceListId: $priceListId
            channelId: $channelId
            customerIds: $customerIds
        ) {
            id
        }
    }
`;

export const REMOVE_CUSTOMERS = gql`
    mutation RemoveCustomers($priceListId: ID!, $channelId: ID!, $customerIds: [ID!]!) {
        removeCustomersFromPriceList(
            priceListId: $priceListId
            channelId: $channelId
            customerIds: $customerIds
        ) {
            id
        }
    }
`;

export const ADD_CUSTOMER_GROUPS = gql`
    mutation AddGroups($priceListId: ID!, $channelId: ID!, $customerGroupIds: [ID!]!) {
        addCustomerGroupsToPriceList(
            priceListId: $priceListId
            channelId: $channelId
            customerGroupIds: $customerGroupIds
        ) {
            id
        }
    }
`;

export const REMOVE_CUSTOMER_GROUPS = gql`
    mutation RemoveGroups($priceListId: ID!, $channelId: ID!, $customerGroupIds: [ID!]!) {
        removeCustomerGroupsFromPriceList(
            priceListId: $priceListId
            channelId: $channelId
            customerGroupIds: $customerGroupIds
        ) {
            id
        }
    }
`;

export const ASSIGNED_CUSTOMERS = gql`
    query AssignedCustomers(
        $priceListId: ID!
        $channelId: ID!
        $options: PriceListCustomerListOptions
    ) {
        priceListAssignedCustomers(
            priceListId: $priceListId
            channelId: $channelId
            options: $options
        ) {
            items {
                id
                emailAddress
            }
            totalItems
        }
    }
`;

export const ASSIGNED_GROUPS = gql`
    query AssignedGroups(
        $priceListId: ID!
        $channelId: ID!
        $options: PriceListCustomerGroupListOptions
    ) {
        priceListAssignedCustomerGroups(
            priceListId: $priceListId
            channelId: $channelId
            options: $options
        ) {
            items {
                id
                name
            }
            totalItems
        }
    }
`;

export const CHANNEL_ACCESS = gql`
    query ChannelAccess($priceListId: ID!, $channelId: ID!) {
        priceListChannelAccess(priceListId: $priceListId, channelId: $channelId) {
            id
            assignedToEveryone
        }
    }
`;

// Plain gql — the plugin-added permission names (ReadPriceList, etc.) are
// not in the static `Permission` enum of the introspection snapshot, so
// we can't use the typed `createRoleDocument` here.
export const CREATE_ROLE = gql`
    mutation CreateRoleE2E($input: CreateRoleInput!) {
        createRole(input: $input) {
            id
            code
        }
    }
`;

export const CREATE_ADMIN = gql`
    mutation CreateAdminE2E($input: CreateAdministratorInput!) {
        createAdministrator(input: $input) {
            id
            emailAddress
        }
    }
`;

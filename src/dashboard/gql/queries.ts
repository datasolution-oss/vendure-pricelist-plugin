import { graphql } from '@/vdb/graphql/graphql.js';

export const priceListsListQuery = graphql(/* GraphQL */ `
  query GetPriceLists($options: PriceListListOptions) {
    priceLists(options: $options) {
      items {
        id
        code
        name
        valueType
        priority
        enabled
        startDate
        endDate
        deletedAt
        originChannel {
          id
          code
        }
        channels {
          id
          code
        }
        createdAt
        updatedAt
      }
      totalItems
    }
  }
`);

/**
 * Detail query — no longer inlines `items`, `assignedCustomers`, or
 * `assignedCustomerGroups`. Those are loaded by dedicated paginated queries
 * (`priceListItems`, `priceListAssignedCustomers`,
 * `priceListAssignedCustomerGroups`) so a list with thousands of
 * customer assignments or item rows doesn't kill the detail page.
 */
export const priceListDetailQuery = graphql(/* GraphQL */ `
  query GetPriceList($id: ID!) {
    priceList(id: $id) {
      id
      code
      name
      description
      valueType
      timezone
      priority
      enabled
      startDate
      endDate
      deletedAt
      purgeAt
      originChannel {
        id
        code
        availableCurrencyCodes
        defaultCurrencyCode
      }
      channels {
        id
        code
      }
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
      translations {
        id
        languageCode
        name
        description
      }
      createdAt
      updatedAt
    }
  }
`);

export const priceListItemsQuery = graphql(/* GraphQL */ `
  query GetPriceListItems($id: ID!, $options: PriceListItemListOptions) {
    priceList(id: $id) {
      id
      items(options: $options) {
        items {
          id
          currencyCode
          value
          stepQuantity
          productVariant {
            id
            name
            sku
          }
        }
        totalItems
      }
    }
  }
`);

/**
 * Per-variant aggregate listing for the items table on the pricelist
 * detail page. One row per distinct ProductVariant. PaginatedListDataTable
 * derives sort/pagination from this query's `options`.
 */
export const priceListVariantSummariesQuery = graphql(/* GraphQL */ `
  query GetPriceListVariantSummaries(
    $priceListId: ID!
    $options: PriceListVariantSummaryListOptions
  ) {
    priceListVariantSummaries(priceListId: $priceListId, options: $options) {
      items {
        id
        productVariant {
          id
          name
          sku
        }
        currencyCount
        tierCount
        cells {
          currencyCode
          stepQuantity
          value
        }
        latestUpdatedAt
      }
      totalItems
    }
  }
`);

/**
 * Catalog prices for a single variant, used by the "add item" dialog
 * to pre-fill the value field with the variant's catalog price for the
 * currently-selected currency. Lets the merchandiser tweak relative to
 * catalog instead of typing from scratch.
 */
export const variantCatalogPricesQuery = graphql(/* GraphQL */ `
  query GetVariantCatalogPrices($id: ID!) {
    productVariant(id: $id) {
      id
      sku
      prices {
        currencyCode
        price
      }
    }
  }
`);

/**
 * Raw cells for the pivot editor on the item-detail page. Returns every
 * (currency, stepQuantity) row for a single (priceList, variant) pair.
 */
export const priceListVariantItemsQuery = graphql(/* GraphQL */ `
  query GetPriceListVariantItems($priceListId: ID!, $productVariantId: ID!) {
    priceListVariantItems(
      priceListId: $priceListId
      productVariantId: $productVariantId
    ) {
      id
      currencyCode
      stepQuantity
      value
      productVariant {
        id
        name
        sku
      }
    }
  }
`);

export const priceListAssignedCustomersQuery = graphql(/* GraphQL */ `
  query GetPriceListAssignedCustomers(
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
        firstName
        lastName
      }
      totalItems
    }
  }
`);

export const priceListAssignedCustomerGroupsQuery = graphql(/* GraphQL */ `
  query GetPriceListAssignedCustomerGroups(
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
`);

/**
 * Per-channel access row (assignedToEveryone) for a (PriceList, Channel)
 * pair. Null when no access has been set yet on that channel.
 */
export const priceListChannelAccessQuery = graphql(/* GraphQL */ `
  query GetPriceListChannelAccess($priceListId: ID!, $channelId: ID!) {
    priceListChannelAccess(priceListId: $priceListId, channelId: $channelId) {
      id
      assignedToEveryone
    }
  }
`);

/** The default group for a channel (channel-side mapping). */
export const priceListDefaultGroupQuery = graphql(/* GraphQL */ `
  query GetPriceListDefaultGroup($channelId: ID!) {
    priceListDefaultGroup(channelId: $channelId) {
      id
      code
      name
    }
  }
`);

export const priceListGroupsListQuery = graphql(/* GraphQL */ `
  query GetPriceListGroups($options: PriceListGroupListOptions) {
    priceListGroups(options: $options) {
      items {
        id
        code
        name
        priority
        createdAt
        updatedAt
      }
      totalItems
    }
  }
`);

export const priceListGroupsByChannelQuery = graphql(/* GraphQL */ `
  query GetPriceListGroupsByChannel($channelId: ID!) {
    priceListGroupsByChannel(channelId: $channelId) {
      id
      code
      name
      priority
    }
  }
`);

/**
 * Pricelists bound to a group (via the membership pivot). Backs the
 * "pricelists in this group" block on the group detail page.
 */
export const priceListsByGroupQuery = graphql(/* GraphQL */ `
  query GetPriceListsByGroup($groupId: ID!, $options: PriceListListOptions) {
    priceListsByGroup(groupId: $groupId, options: $options) {
      items {
        id
        code
        name
        valueType
        enabled
        originChannel {
          id
          code
        }
      }
      totalItems
    }
  }
`);

export const priceListGroupDetailQuery = graphql(/* GraphQL */ `
  query GetPriceListGroup($id: ID!) {
    priceListGroup(id: $id) {
      id
      code
      name
      priority
      channels {
        id
        code
      }
      translations {
        id
        languageCode
        name
      }
      createdAt
      updatedAt
    }
  }
`);

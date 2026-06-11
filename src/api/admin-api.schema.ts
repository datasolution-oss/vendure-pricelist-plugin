import gql from 'graphql-tag';

export const adminApiExtensions = gql`
    # ---- Types ----

    type PriceList implements Node {
        id: ID!
        code: String!
        name: String!
        description: String
        """
        Whether this list's items are absolute prices (minor units) or
        percentage discounts (basis points). One value per list — items can
        no longer mix conventions within a single list.
        """
        valueType: PriceListValueType!
        """
        IANA timezone name (e.g. \`Europe/Paris\`). \`startDate\`/\`endDate\`
        are interpreted in this zone.
        """
        timezone: String!
        startDate: DateTime
        endDate: DateTime
        priority: Int!
        enabled: Boolean!
        originChannel: Channel!
        channels: [Channel!]!
        groupMemberships: [PriceListGroupMembership!]!
        items(options: PriceListItemListOptions): PriceListItemList!
        """
        Customer access is decided per-channel — see \`PriceListChannelAccess\`
        and the \`priceListChannelAccess\` / paginated
        \`priceListAssignedCustomers\` / \`priceListAssignedCustomerGroups\`
        queries (all take a \`channelId\`). Not exposed inline here: a list
        can carry thousands of assignments per channel.
        """
        translations: [PriceListTranslation!]!
        customFields: JSON
        createdAt: DateTime!
        updatedAt: DateTime!
        deletedAt: DateTime
        """
        When a pending-deletion list will be hard-deleted by the purge
        cron (= deletedAt + grace period). Null when the list is active
        or when the purge task is disabled. Computed, not stored.
        """
        purgeAt: DateTime
    }

    type PriceListGroupMembership implements Node {
        id: ID!
        priceList: PriceList!
        """The channel this binding applies to (explicit — groups are now shareable)."""
        channel: Channel!
        group: PriceListGroup!
        createdAt: DateTime!
        updatedAt: DateTime!
    }

    """
    Per-channel customer-access scope for a PriceList. Access (everyone /
    direct customers / customer groups) is decided per (PriceList, Channel),
    not globally on the list.
    """
    type PriceListChannelAccess implements Node {
        id: ID!
        priceList: PriceList!
        channel: Channel!
        assignedToEveryone: Boolean!
        createdAt: DateTime!
        updatedAt: DateTime!
    }

    type PriceListTranslation {
        id: ID!
        languageCode: LanguageCode!
        name: String!
        description: String
        createdAt: DateTime!
        updatedAt: DateTime!
    }

    type PriceListItem implements Node {
        id: ID!
        priceList: PriceList!
        productVariant: ProductVariant!
        currencyCode: CurrencyCode!
        """
        Interpretation depends on the parent \`PriceList.valueType\`:
        ABSOLUTE → integer minor units; PERCENTAGE → basis points of
        discount (1000 = -10%).
        """
        value: Int!
        stepQuantity: Int!
        customFields: JSON
        createdAt: DateTime!
        updatedAt: DateTime!
    }

    enum PriceListValueType {
        ABSOLUTE
        PERCENTAGE
    }

    type PriceListGroup implements Node {
        id: ID!
        code: String!
        name: String!
        priority: Int!
        """
        The channel this group belongs to. Backed by the entity's
        ChannelAware ManyToMany relation (a group is assigned to exactly one
        channel); exposed as a single value to match that invariant. The
        "default group per channel" is queried via
        \`priceListDefaultGroup(channelId)\`.
        """
        channel: Channel!
        translations: [PriceListGroupTranslation!]!
        customFields: JSON
        createdAt: DateTime!
        updatedAt: DateTime!
    }

    type PriceListGroupTranslation {
        id: ID!
        languageCode: LanguageCode!
        name: String!
        createdAt: DateTime!
        updatedAt: DateTime!
    }

    type PriceListList implements PaginatedList {
        items: [PriceList!]!
        totalItems: Int!
    }

    type PriceListItemList implements PaginatedList {
        items: [PriceListItem!]!
        totalItems: Int!
    }

    type PriceListGroupList implements PaginatedList {
        items: [PriceListGroup!]!
        totalItems: Int!
    }

    """
    Inlined cell of a PriceListVariantSummary — one
    (currency, stepQuantity, value) triple. Inlined rather than fetched
    separately so the dashboard can render a hover-detail without a
    second round-trip.
    """
    type PriceListVariantSummaryCell {
        currencyCode: CurrencyCode!
        stepQuantity: Int!
        value: Int!
    }

    """
    Aggregate row: one entry per distinct ProductVariant present in a
    pricelist, with counts of currencies/tiers and the latest item
    write timestamp. Drives the per-SKU listing on the pricelist detail
    page; full pivot edit lives on the item-detail page.

    The id field is the ProductVariant id (one summary row per variant,
    so the variant id is a stable row identifier). Required because
    PaginatedList.items is declared as [Node!]! upstream.
    """
    type PriceListVariantSummary implements Node {
        id: ID!
        productVariant: ProductVariant!
        """Distinct currency codes priced for this variant in the list."""
        currencyCount: Int!
        """Distinct stepQuantity tiers defined for this variant."""
        tierCount: Int!
        """Total filled cells. Generally ≤ currencyCount × tierCount when the pivot isn't a full cross."""
        cellCount: Int!
        """All cells for this variant, ordered by currency then stepQuantity."""
        cells: [PriceListVariantSummaryCell!]!
        latestUpdatedAt: DateTime!
    }

    type PriceListVariantSummaryList implements PaginatedList {
        items: [PriceListVariantSummary!]!
        totalItems: Int!
    }

    type PriceListCustomerList implements PaginatedList {
        items: [Customer!]!
        totalItems: Int!
    }

    type PriceListCustomerGroupList implements PaginatedList {
        items: [CustomerGroup!]!
        totalItems: Int!
    }

    input PriceListListOptions {
        skip: Int
        take: Int
        """
        When true, soft-deleted pricelists (those awaiting purge by the
        cron task) are included in the result. Default false — the
        canonical list view hides them. The dashboard's "Show pending
        deletion" toggle drives this flag.
        """
        includeDeleted: Boolean
    }

    input PriceListItemListOptions {
        skip: Int
        take: Int
    }

    input PriceListVariantSummaryListOptions {
        skip: Int
        take: Int
    }

    input PriceListGroupListOptions {
        skip: Int
        take: Int
    }

    """
    Filter is a substring match against email, first/last name. Empty
    string returns all rows.
    """
    input PriceListCustomerListOptions {
        skip: Int
        take: Int
        filter: String
    }

    input PriceListCustomerGroupListOptions {
        skip: Int
        take: Int
        filter: String
    }

    # ---- Queries ----

    extend type Query {
        priceList(id: ID!): PriceList
        priceLists(options: PriceListListOptions): PriceListList!
        priceListGroup(id: ID!): PriceListGroup
        priceListGroups(options: PriceListGroupListOptions): PriceListGroupList!
        """
        Returns all PriceListGroups owned by the given channel, regardless of
        which channel is currently active. Used by the share-to-channel dialog
        to populate the destination-group dropdown for a target channel.
        """
        priceListGroupsByChannel(channelId: ID!): [PriceListGroup!]!
        """The default PriceListGroup for a channel (channel-side mapping)."""
        priceListDefaultGroup(channelId: ID!): PriceListGroup!
        """Per-channel access row for a (PriceList, Channel) pair, if any."""
        priceListChannelAccess(priceListId: ID!, channelId: ID!): PriceListChannelAccess
        """
        Paginated list of pricelists bound to a group (via the
        membership pivot). Backs the "pricelists in this group" block
        on the group detail page.
        """
        priceListsByGroup(groupId: ID!, options: PriceListListOptions): PriceListList!
        """
        Per-variant aggregate listing for a pricelist. Each row is one
        ProductVariant present in the list with summary counts. Use
        \`priceListVariantItems\` to load the underlying rows for editing.
        """
        priceListVariantSummaries(
            priceListId: ID!
            options: PriceListVariantSummaryListOptions
        ): PriceListVariantSummaryList!
        """
        Returns every PriceListItem row for a single (priceList, variant)
        pair — the raw cells of the pivot editor. Not paginated: a
        single variant rarely carries more than a handful of cells
        (currencies × stepQuantity tiers).
        """
        priceListVariantItems(
            priceListId: ID!
            productVariantId: ID!
        ): [PriceListItem!]!
        """
        Paginated lookup of customers directly assigned to a list.
        Replaces the previously-inlined \`assignedCustomers\` field, which
        was unworkable at the typical assignment counts.
        """
        priceListAssignedCustomers(
            priceListId: ID!
            channelId: ID!
            options: PriceListCustomerListOptions
        ): PriceListCustomerList!
        """
        Paginated lookup of customer groups assigned to a list.
        """
        priceListAssignedCustomerGroups(
            priceListId: ID!
            channelId: ID!
            options: PriceListCustomerGroupListOptions
        ): PriceListCustomerGroupList!
    }

    # ---- Mutations ----

    extend type Mutation {
        # PriceList CRUD
        createPriceList(input: CreatePriceListInput!): PriceList!
        updatePriceList(input: UpdatePriceListInput!): PriceList!
        """
        Soft-deletes the pricelist (sets \`deletedAt\`). The cron task
        \`pricelist-purge-pending-deletion\` hard-deletes it after the
        configured grace period (default 1h). Call \`restorePriceList\`
        any time before that to bring it back to active.
        """
        deletePriceList(id: ID!): DeletionResponse!
        """
        Cancel a pending deletion: clears \`deletedAt\` so the cron task
        no longer picks the pricelist up. No-op if the pricelist is
        already active (idempotent). Errors if called from a channel
        other than the pricelist's origin.
        """
        restorePriceList(id: ID!): PriceList!

        # Items
        addPriceListItem(input: CreatePriceListItemInput!): PriceListItem!
        updatePriceListItem(input: UpdatePriceListItemInput!): PriceListItem!
        removePriceListItem(id: ID!): DeletionResponse!
        """
        Replace the full pivot (currencies × stepQuantities) for a
        single (priceList, variant) pair. Diffs incoming rows against
        stored: INSERT new cells, UPDATE changed values, DELETE missing.
        Sending an empty \`rows\` clears every cell for the variant.
        Atomic — wrapped in a transaction.
        """
        savePriceListVariantPivot(
            input: SavePriceListVariantPivotInput!
        ): [PriceListItem!]!

        # Channel sharing
        assignPriceListToChannel(input: AssignPriceListToChannelInput!): PriceList!
        removePriceListFromChannel(priceListId: ID!, channelId: ID!): PriceList!
        """
        Reassign the group a pricelist belongs to on a given channel.
        The membership for that channel is repointed at \`groupId\`,
        which must itself belong to \`channelId\`. Errors if no binding
        exists for the channel yet (use assignPriceListToChannel to
        create one).
        """
        changePriceListGroup(priceListId: ID!, channelId: ID!, groupId: ID!): PriceList!

        # PriceListGroup CRUD
        createPriceListGroup(input: CreatePriceListGroupInput!): PriceListGroup!
        updatePriceListGroup(input: UpdatePriceListGroupInput!): PriceListGroup!
        deletePriceListGroup(id: ID!): DeletionResponse!
        setDefaultPriceListGroup(channelId: ID!, groupId: ID!): PriceListGroup!

        # PriceList per-channel access management — channelId required, returns
        # the affected (PriceList, Channel) access row.
        setPriceListAssignedToEveryone(priceListId: ID!, channelId: ID!, assigned: Boolean!): PriceListChannelAccess!
        addCustomersToPriceList(priceListId: ID!, channelId: ID!, customerIds: [ID!]!): PriceListChannelAccess!
        removeCustomersFromPriceList(priceListId: ID!, channelId: ID!, customerIds: [ID!]!): PriceListChannelAccess!
        addCustomerGroupsToPriceList(priceListId: ID!, channelId: ID!, customerGroupIds: [ID!]!): PriceListChannelAccess!
        removeCustomerGroupsFromPriceList(priceListId: ID!, channelId: ID!, customerGroupIds: [ID!]!): PriceListChannelAccess!

    }

    # ---- Input types ----

    input PriceListTranslationInput {
        id: ID
        languageCode: LanguageCode!
        name: String!
        description: String
    }

    """
    \`timezone\` is currently optional in the schema (held back from the
    dashboard at the PO's direction — Stage 1D). When omitted, the
    server falls back to \`UTC\`. Will become required again when the
    Stage-2 lookup consumes it and the dashboard re-mounts the picker.
    """
    input CreatePriceListInput {
        code: String!
        valueType: PriceListValueType!
        timezone: String
        startDate: DateTime
        endDate: DateTime
        priority: Int!
        enabled: Boolean
        groupId: ID
        translations: [PriceListTranslationInput!]!
        customFields: JSON
    }

    """
    \`valueType\` is intentionally NOT updatable — changing it mid-life would
    silently re-interpret every existing item value. To switch type, create
    a new list and migrate assignments.
    """
    input UpdatePriceListInput {
        id: ID!
        code: String
        timezone: String
        startDate: DateTime
        endDate: DateTime
        priority: Int
        enabled: Boolean
        translations: [PriceListTranslationInput!]
        customFields: JSON
    }

    input CreatePriceListItemInput {
        priceListId: ID!
        productVariantId: ID!
        currencyCode: CurrencyCode!
        value: Int!
        stepQuantity: Int
        customFields: JSON
    }

    input UpdatePriceListItemInput {
        id: ID!
        value: Int
        stepQuantity: Int
        customFields: JSON
    }

    input PriceListVariantPivotRowInput {
        currencyCode: CurrencyCode!
        stepQuantity: Int!
        value: Int!
    }

    input SavePriceListVariantPivotInput {
        priceListId: ID!
        productVariantId: ID!
        rows: [PriceListVariantPivotRowInput!]!
    }

    input AssignPriceListToChannelInput {
        priceListId: ID!
        channelId: ID!
        """Optional — falls back to the target channel's default group."""
        groupId: ID
    }

    input PriceListGroupTranslationInput {
        id: ID
        languageCode: LanguageCode!
        name: String!
    }

    input CreatePriceListGroupInput {
        code: String!
        priority: Int!
        translations: [PriceListGroupTranslationInput!]!
        customFields: JSON
    }

    input UpdatePriceListGroupInput {
        id: ID!
        code: String
        priority: Int
        translations: [PriceListGroupTranslationInput!]
        customFields: JSON
    }
`;

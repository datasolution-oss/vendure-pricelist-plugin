import { PriceListGroup } from './entities/price-list-group.entity';

/**
 * Name of the relation custom field added to `Channel` to hold the
 * channel's default `PriceListGroup`.
 *
 * Replaces the former dedicated `PriceListChannelDefaultGroup` entity: the
 * "default" is a 1:1 fact about the channel, so it lives channel-side as a
 * relation custom field — the same pattern Vendure core uses for
 * `Channel.defaultTaxZone` / `defaultShippingZone`. The column being on the
 * `channel` row makes "exactly one default per channel" structural (no
 * `UNIQUE(channelId)` table constraint needed).
 *
 * A new list created on a channel with no explicit group lands in the group
 * referenced here. Per-list group binding is unrelated and stays in the
 * `PriceListGroupMembership` entity (N rows per channel).
 */
export const DEFAULT_PRICE_LIST_GROUP_FIELD = 'defaultPriceListGroup';

declare module '@vendure/core/dist/entity/custom-entity-fields' {
    interface CustomChannelFields {
        defaultPriceListGroup?: PriceListGroup | null;
    }
}

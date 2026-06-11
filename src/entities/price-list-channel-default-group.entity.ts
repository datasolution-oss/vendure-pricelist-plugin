import { DeepPartial, ID } from '@vendure/common/lib/shared-types';
import { Channel, VendureEntity } from '@vendure/core';
import { Column, Entity, ManyToOne, Unique } from 'typeorm';

import { PriceListGroup } from './price-list-group.entity';

/**
 * Per-channel default PriceListGroup, stored channel-side — the same
 * pattern Vendure core uses for `Channel.defaultTaxZone` /
 * `defaultShippingZone` (the "default" is a fact about the channel, not a
 * flag on the shared entity).
 *
 * Replaces the former `PriceListGroup.isDefault` boolean, which could not
 * express "group G is the default on channel A but not on channel B" once
 * groups became shareable (`ChannelAware`).
 *
 * `UNIQUE(channelId)` enforces exactly one default group per channel.
 * A new list created on a channel with no explicit group lands in the
 * group referenced here.
 */
@Entity()
@Unique(['channelId'])
export class PriceListChannelDefaultGroup extends VendureEntity {
    constructor(input?: DeepPartial<PriceListChannelDefaultGroup>) {
        super(input);
    }

    @ManyToOne(() => Channel, { nullable: false, onDelete: 'CASCADE' })
    channel: Channel;

    @Column()
    channelId: ID;

    @ManyToOne(() => PriceListGroup, { nullable: false, onDelete: 'CASCADE' })
    group: PriceListGroup;

    @Column()
    groupId: ID;
}

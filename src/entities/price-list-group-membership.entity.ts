import { DeepPartial, ID } from '@vendure/common/lib/shared-types';
import { Channel, VendureEntity } from '@vendure/core';
import { Column, Entity, ManyToOne, Unique } from 'typeorm';

import { PriceListGroup } from './price-list-group.entity';
import { PriceList } from './price-list.entity';

/**
 * Per-channel binding of a PriceList into a PriceListGroup:
 * `(priceList, channel, group)`.
 *
 * The `channel` column is explicit (no longer derived from the group)
 * because groups are now `ChannelAware` and may be shared across
 * channels — a single group could back the binding on several channels,
 * so the membership must record which channel it applies to.
 *
 * `UNIQUE(priceList, channel)` enforces "one group per channel for a
 * given list". Service-layer additionally asserts the bound `group` is
 * assigned to `channel` (i.e. `group.channels` contains it) — a
 * cross-table invariant not expressible as a DB FK.
 *
 * Custom entity (rather than a plain `@JoinTable` ManyToMany) so we can:
 * - expose `createdAt`/`updatedAt` for forensics
 * - extend with extra columns later without a heavy migration
 */
@Entity()
@Unique(['priceList', 'channel'])
export class PriceListGroupMembership extends VendureEntity {
    constructor(input?: DeepPartial<PriceListGroupMembership>) {
        super(input);
    }

    @ManyToOne(() => PriceList, list => list.groupMemberships, { onDelete: 'CASCADE' })
    priceList: PriceList;

    @Column()
    priceListId: ID;

    @ManyToOne(() => Channel, { nullable: false, onDelete: 'CASCADE' })
    channel: Channel;

    @Column()
    channelId: ID;

    @ManyToOne(() => PriceListGroup, { nullable: false, onDelete: 'RESTRICT' })
    group: PriceListGroup;

    @Column()
    groupId: ID;
}

import { DeepPartial, ID } from '@vendure/common/lib/shared-types';
import { VendureEntity } from '@vendure/core';
import { Column, Entity, ManyToOne, Unique } from 'typeorm';

import { PriceListGroup } from './price-list-group.entity';
import { PriceList } from './price-list.entity';

/**
 * Membership of a PriceList in a PriceListGroup. The pivot carries no
 * channel column — the channel is derived from `group.channelId` since
 * `PriceListGroup` is channel-local. Service-layer enforces "at most one
 * group per channel for a given list" by ensuring no two memberships
 * point at groups on the same channel.
 *
 * Custom entity (rather than a plain `@JoinTable` ManyToMany) so we can:
 * - expose `createdAt`/`updatedAt` for forensics
 * - extend with extra columns later without a heavy migration
 */
@Entity()
@Unique(['priceList', 'group'])
export class PriceListGroupMembership extends VendureEntity {
    constructor(input?: DeepPartial<PriceListGroupMembership>) {
        super(input);
    }

    @ManyToOne(() => PriceList, list => list.groupMemberships, { onDelete: 'CASCADE' })
    priceList: PriceList;

    @Column()
    priceListId: ID;

    @ManyToOne(() => PriceListGroup, { nullable: false, onDelete: 'RESTRICT' })
    group: PriceListGroup;

    @Column()
    groupId: ID;
}

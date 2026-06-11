import { DeepPartial, ID } from '@vendure/common/lib/shared-types';
import { Channel, Customer, CustomerGroup, VendureEntity } from '@vendure/core';
import {
    Column,
    Entity,
    JoinTable,
    ManyToMany,
    ManyToOne,
    Unique,
} from 'typeorm';

import { PriceList } from './price-list.entity';

/**
 * Customer-access scope for a PriceList on a single channel:
 * `(priceList, channel)` → who may see the list **on that channel**.
 *
 * Access is per-channel (not global on the list): a list shared to
 * channels A and B can grant different customers on each, and
 * `assignedToEveryone` is itself per channel. The Stage-2 lookup reads
 * the row matching the request's channel and ORs
 * `assignedToEveryone || customers || customerGroups`.
 *
 * One row per channel the list participates in, created lazily on the
 * first access mutation for that channel (or alongside the channel
 * membership). `UNIQUE(priceListId, channelId)`.
 *
 * Managing this row is a channel-local action: allowed for a user
 * holding `ManagePriceListAccess` on `channelId`, even when the list's
 * content is owned by a different origin channel.
 */
@Entity()
@Unique(['priceListId', 'channelId'])
export class PriceListChannelAccess extends VendureEntity {
    constructor(input?: DeepPartial<PriceListChannelAccess>) {
        super(input);
    }

    @ManyToOne(() => PriceList, list => list.channelAccess, { onDelete: 'CASCADE' })
    priceList: PriceList;

    @Column()
    priceListId: ID;

    @ManyToOne(() => Channel, { nullable: false, onDelete: 'CASCADE' })
    channel: Channel;

    @Column()
    channelId: ID;

    /** Global access on this channel — every customer of the channel sees the list. */
    @Column({ default: false })
    assignedToEveryone: boolean;

    // Explicit join-table + column names so the table identifiers are
    // authoritative (not derived from property names) — the paginated
    // lookups in PriceListAccessService join these tables by name, and
    // the migration creates them; pinning the names keeps both in lock-step
    // and immune to a property rename.
    @ManyToMany(() => Customer)
    @JoinTable({
        name: 'price_list_channel_access_customer',
        joinColumn: { name: 'accessId', referencedColumnName: 'id' },
        inverseJoinColumn: { name: 'customerId', referencedColumnName: 'id' },
    })
    customers: Customer[];

    @ManyToMany(() => CustomerGroup)
    @JoinTable({
        name: 'price_list_channel_access_customer_group',
        joinColumn: { name: 'accessId', referencedColumnName: 'id' },
        inverseJoinColumn: { name: 'customerGroupId', referencedColumnName: 'id' },
    })
    customerGroups: CustomerGroup[];
}

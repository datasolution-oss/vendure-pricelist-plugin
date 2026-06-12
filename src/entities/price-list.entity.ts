import { DeepPartial, ID } from '@vendure/common/lib/shared-types';
import {
    Channel,
    ChannelAware,
    HasCustomFields,
    LocaleString,
    SoftDeletable,
    Translatable,
    Translation,
    VendureEntity,
} from '@vendure/core';
import {
    Column,
    Entity,
    Index,
    JoinColumn,
    JoinTable,
    ManyToMany,
    ManyToOne,
    OneToMany,
} from 'typeorm';

import { CustomPriceListFields } from '../custom-entity-fields';
import { PriceListChannelAccess } from './price-list-channel-access.entity';
import { PriceListGroupMembership } from './price-list-group-membership.entity';
import { PriceListItem, PriceListValueType } from './price-list-item.entity';
import { PriceListTranslation } from './price-list-translation.entity';

@Entity()
@Index(['startDate', 'endDate'])
// Partial index serving the purge cron's `deletedAt IS NOT NULL AND
// deletedAt < cutoff ORDER BY deletedAt` scan. Partial (Postgres) keeps it
// tiny — it indexes only soft-deleted rows, not the live majority that
// every listing filters out with `deletedAt IS NULL`.
@Index(['deletedAt'], { where: '"deletedAt" IS NOT NULL' })
// Backs `findByCode` (where { code, originChannelId, deletedAt }) and the
// `originChannel` FK (RESTRICT) integrity check on channel deletion.
@Index(['originChannelId', 'code'])
export class PriceList
    extends VendureEntity
    implements ChannelAware, SoftDeletable, Translatable, HasCustomFields
{
    constructor(input?: DeepPartial<PriceList>) {
        super(input);
    }

    @Column()
    code: string;

    /**
     * Resolved at query time from the active language's `PriceListTranslation`.
     * `description` follows the same pattern — translations may store `""`
     * for "no description"; the Shop API may map empty strings to `null`.
     */
    name: LocaleString;

    description: LocaleString;

    /**
     * Whether the items in this pricelist carry ABSOLUTE prices (integer
     * minor units) or PERCENTAGE discounts (basis points). All items in a
     * single list share the same valueType — moved up from `PriceListItem`
     * on PO direction so a pricelist can't accidentally mix the two
     * conventions in the cascade.
     */
    @Column({ type: 'varchar', length: 16, default: 'ABSOLUTE' })
    valueType: PriceListValueType;

    /**
     * IANA timezone name (e.g. `Europe/Paris`). The `startDate`/`endDate`
     * validity window is interpreted in this timezone. Stage 2 lookup
     * converts the merchandiser-set bounds against this zone when
     * comparing to "now". Required — defaults to `UTC` at insert time but
     * the dashboard always asks for a value.
     */
    @Column({ type: 'varchar', length: 64, default: 'UTC' })
    timezone: string;

    @Column({ type: Date, nullable: true })
    startDate: Date | null;

    @Column({ type: Date, nullable: true })
    endDate: Date | null;

    @Column({ default: 0 })
    priority: number;

    @Column({ default: true })
    enabled: boolean;

    /**
     * The channel that originally created this PriceList. Edits are allowed
     * only from this channel (the read-only-on-non-origin guard, §0.2.11).
     */
    @ManyToOne(() => Channel, { nullable: false })
    @JoinColumn()
    originChannel: Channel;

    @Column()
    originChannelId: ID;

    /**
     * Standard Vendure ChannelAware many-to-many. Drives `findOneInChannel`
     * and Vendure's channel-filtering machinery. Whether a list "exists" on
     * channel C is decided by membership in this relation.
     *
     * The per-channel group binding lives separately in
     * `PriceListGroupMembership` (a group is itself channel-local, so its
     * channelId tells us which channel a membership applies to).
     */
    @ManyToMany(() => Channel)
    @JoinTable()
    channels: Channel[];

    /**
     * Per-channel customer access scopes. Access (assignedToEveryone +
     * direct customers + customer groups) is decided per
     * `(PriceList, Channel)` via `PriceListChannelAccess`, NOT globally on
     * the list: a list shared to channels A and B may grant different
     * customers on each. Stage 2 lookup reads the row for the request's
     * channel. One row per channel the list participates in.
     */
    @OneToMany(() => PriceListChannelAccess, a => a.priceList)
    channelAccess: PriceListChannelAccess[];

    @OneToMany(() => PriceListTranslation, t => t.base, { eager: true })
    translations: Array<Translation<PriceList>>;

    @OneToMany(() => PriceListItem, item => item.priceList)
    items: PriceListItem[];

    /**
     * Per-channel group bindings `(priceList, channel, group)`. The
     * membership row carries its own `channelId` (groups are now
     * ChannelAware and may be shared, so the channel is no longer derived
     * from the group).
     */
    @OneToMany(() => PriceListGroupMembership, m => m.priceList)
    groupMemberships: PriceListGroupMembership[];

    @Column({ type: Date, nullable: true })
    deletedAt: Date | null;

    /**
     * Standard Vendure custom-fields slot — an embedded carrier populated at
     * bootstrap from `config.customFields.PriceList`. Empty by default; a
     * merchant extends it like any core entity. `localeString`/`localeText`
     * fields land on `PriceListTranslation.customFields`.
     */
    @Column(() => CustomPriceListFields)
    customFields: CustomPriceListFields;
}

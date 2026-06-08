import { DeepPartial, ID } from '@vendure/common/lib/shared-types';
import {
    Channel,
    ChannelAware,
    Customer,
    CustomerGroup,
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

import { PriceListGroupMembership } from './price-list-group-membership.entity';
import { PriceListItem, PriceListValueType } from './price-list-item.entity';
import { PriceListTranslation } from './price-list-translation.entity';

@Entity()
@Index(['startDate', 'endDate'])
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

    @Column({ type: 'timestamp', nullable: true })
    startDate: Date | null;

    @Column({ type: 'timestamp', nullable: true })
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
     * Direct customer assignments — this list is accessible to each listed
     * customer regardless of group membership. Stage 2 lookup ORs this with
     * `assignedCustomerGroups` and `assignedToEveryone`.
     */
    @ManyToMany(() => Customer)
    @JoinTable()
    assignedCustomers: Customer[];

    @ManyToMany(() => CustomerGroup)
    @JoinTable()
    assignedCustomerGroups: CustomerGroup[];

    /** Global access — every customer can see this list. */
    @Column({ default: false })
    assignedToEveryone: boolean;

    @OneToMany(() => PriceListTranslation, t => t.base, { eager: true })
    translations: Array<Translation<PriceList>>;

    @OneToMany(() => PriceListItem, item => item.priceList)
    items: PriceListItem[];

    /**
     * Per-channel group bindings. Each membership row points at a
     * PriceListGroup; the group's `channelId` defines which channel that
     * binding applies to (groups are channel-local).
     */
    @OneToMany(() => PriceListGroupMembership, m => m.priceList)
    groupMemberships: PriceListGroupMembership[];

    @Column({ type: 'timestamp', nullable: true })
    deletedAt: Date | null;

    /**
     * Free-form metadata bag. Plugin-defined entities cannot participate in
     * Vendure's auto-generated `Custom<Entity>Fields` typing (that machinery
     * targets core entities only), so we expose a `simple-json` column.
     */
    @Column({ type: 'simple-json', default: '{}' })
    customFields: { [key: string]: any } = {};
}

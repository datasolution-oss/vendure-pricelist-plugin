import { DeepPartial } from '@vendure/common/lib/shared-types';
import {
    Channel,
    ChannelAware,
    HasCustomFields,
    LocaleString,
    Translatable,
    Translation,
    VendureEntity,
} from '@vendure/core';
import { Column, Entity, JoinTable, ManyToMany, OneToMany } from 'typeorm';

import { CustomPriceListGroupFields } from '../custom-entity-fields';
import { PriceListGroupTranslation } from './price-list-group-translation.entity';

/**
 * Organisational/priority bucket for PriceLists.
 *
 * `ChannelAware` (ManyToMany `channels`) — like every channel-scoped
 * entity in Vendure core. By default a group is assigned to exactly one
 * channel (its creating channel), so the user-facing behaviour is
 * "one group lives in one channel"; the ManyToMany simply leaves the
 * door open to sharing a group across channels later without a schema
 * change, and lets `ListQueryBuilder({ channelId })` scope groups
 * automatically instead of hand-rolled `channelId` filters.
 *
 * Holds NO access-scoping information — customer access is decided at the
 * `(PriceList, Channel)` level (see `PriceListChannelAccess`). The
 * "default group **per channel**" is stored channel-side as the
 * `Channel.defaultPriceListGroup` relation custom field (mirrors
 * `Channel.defaultTaxZone`), so there is deliberately no `isDefault` flag
 * here: a boolean on a shareable entity cannot express "default on A but
 * not on B".
 */
@Entity()
export class PriceListGroup
    extends VendureEntity
    implements ChannelAware, Translatable, HasCustomFields
{
    constructor(input?: DeepPartial<PriceListGroup>) {
        super(input);
    }

    @Column()
    code: string;

    name: LocaleString;

    @Column({ default: 0 })
    priority: number;

    @ManyToMany(() => Channel)
    @JoinTable()
    channels: Channel[];

    @OneToMany(() => PriceListGroupTranslation, t => t.base, { eager: true })
    translations: Array<Translation<PriceListGroup>>;

    /** Standard Vendure custom-fields slot — see `PriceList.customFields`. */
    @Column(() => CustomPriceListGroupFields)
    customFields: CustomPriceListGroupFields;
}

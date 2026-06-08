import { DeepPartial, ID } from '@vendure/common/lib/shared-types';
import {
    Channel,
    HasCustomFields,
    LocaleString,
    Translatable,
    Translation,
    VendureEntity,
} from '@vendure/core';
import { Column, Entity, Index, ManyToOne, OneToMany } from 'typeorm';


import { PriceListGroupTranslation } from './price-list-group-translation.entity';

/**
 * Channel-local organisational/priority bucket for PriceLists. Holds NO
 * access-scoping information — groups are global within their channel.
 * Customer access is decided exclusively at the PriceList level
 * (PriceList.assignedToEveryone / assignedCustomers / assignedCustomerGroups).
 */
@Entity()
@Index(['channelId'])
export class PriceListGroup
    extends VendureEntity
    implements Translatable, HasCustomFields
{
    constructor(input?: DeepPartial<PriceListGroup>) {
        super(input);
    }

    @Column()
    code: string;

    name: LocaleString;

    @Column({ default: 0 })
    priority: number;

    @Column({ default: false })
    isDefault: boolean;

    @ManyToOne(() => Channel, { nullable: false })
    channel: Channel;

    @Column()
    channelId: ID;

    @OneToMany(() => PriceListGroupTranslation, t => t.base, { eager: true })
    translations: Array<Translation<PriceListGroup>>;

    /** See `PriceList.customFields` for rationale. */
    @Column({ type: 'simple-json', default: '{}' })
    customFields: { [key: string]: any } = {};
}

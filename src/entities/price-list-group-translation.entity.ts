import { LanguageCode } from '@vendure/common/lib/generated-types';
import { CustomFieldsObject, DeepPartial } from '@vendure/common/lib/shared-types';
import { Translation, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne } from 'typeorm';

import { PriceListGroup } from './price-list-group.entity';

@Entity()
export class PriceListGroupTranslation
    extends VendureEntity
    implements Translation<PriceListGroup>
{
    constructor(input?: DeepPartial<Translation<PriceListGroupTranslation>>) {
        super(input);
    }

    @Column('varchar')
    languageCode: LanguageCode;

    @Column()
    name: string;

    @Index()
    @ManyToOne(() => PriceListGroup, base => base.translations, { onDelete: 'CASCADE' })
    base: PriceListGroup;

    /** Required by `Translation<T>` when the parent has `customFields`. */
    @Column({ type: 'simple-json', default: '{}' })
    customFields: CustomFieldsObject = {};
}

import { LanguageCode } from '@vendure/common/lib/generated-types';
import { CustomFieldsObject, DeepPartial } from '@vendure/common/lib/shared-types';
import { Translation, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne } from 'typeorm';

import { PriceList } from './price-list.entity';

@Entity()
export class PriceListTranslation
    extends VendureEntity
    implements Translation<PriceList>
{
    constructor(input?: DeepPartial<Translation<PriceListTranslation>>) {
        super(input);
    }

    @Column('varchar')
    languageCode: LanguageCode;

    @Column()
    name: string;

    /**
     * Per-language description. Non-nullable (matches `LocaleString` on the
     * parent); use `""` to represent "no description". The GraphQL resolver
     * surface maps empty strings back to `null` for storefront ergonomics.
     */
    @Column({ type: 'text', default: '' })
    description: string;

    @Index()
    @ManyToOne(() => PriceList, base => base.translations, { onDelete: 'CASCADE' })
    base: PriceList;

    /**
     * Required by `Translation<T>` when the parent has `customFields`. Same
     * "free-form JSON bag" pattern as the entity itself.
     */
    @Column({ type: 'simple-json', default: '{}' })
    customFields: CustomFieldsObject = {};
}

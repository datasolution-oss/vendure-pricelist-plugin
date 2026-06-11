import { LanguageCode } from '@vendure/common/lib/generated-types';
import { DeepPartial } from '@vendure/common/lib/shared-types';
import { Translation, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne } from 'typeorm';

import { CustomPriceListFieldsTranslation } from '../custom-entity-fields';
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
     * Standard Vendure custom-fields slot for the translation — carries the
     * `localeString`/`localeText` custom fields configured on `PriceList`.
     */
    @Column(() => CustomPriceListFieldsTranslation)
    customFields: CustomPriceListFieldsTranslation;
}

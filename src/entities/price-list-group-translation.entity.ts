import { LanguageCode } from '@vendure/common/lib/generated-types';
import { DeepPartial } from '@vendure/common/lib/shared-types';
import { Translation, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne } from 'typeorm';

import { CustomPriceListGroupFieldsTranslation } from '../custom-entity-fields';
import { PriceListGroup } from './price-list-group.entity';

@Entity()
export class PriceListGroupTranslation extends VendureEntity implements Translation<PriceListGroup> {
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

  /** Standard Vendure custom-fields slot for the translation. */
  @Column(() => CustomPriceListGroupFieldsTranslation)
  customFields: CustomPriceListGroupFieldsTranslation;
}

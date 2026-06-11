/**
 * Embedded custom-field carrier classes for the plugin's entities, following
 * the Vendure-canonical pattern (see core `custom-entity-fields.ts`): each
 * custom-field-aware entity embeds an (initially empty) class via
 * `@Column(type => CustomXxxFields)`. Vendure's `registerCustomEntityFields`
 * populates these classes with columns at bootstrap from
 * `config.customFields[EntityName]`, so a merchant can extend these entities
 * with typed, admin-UI-managed custom fields exactly like a core entity.
 *
 * They are deliberately left empty here: the plugin ships no custom fields of
 * its own, it only opens the standard extension point.
 *
 * Translatable entities also embed a `...Translation` carrier so `localeString`
 * / `localeText` custom fields land on the translation table.
 */

export class CustomPriceListFields {}
export class CustomPriceListFieldsTranslation {}

export class CustomPriceListGroupFields {}
export class CustomPriceListGroupFieldsTranslation {}

export class CustomPriceListItemFields {}

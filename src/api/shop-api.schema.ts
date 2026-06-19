import gql from 'graphql-tag';

/**
 * Stage 3 §2.3 — strike-through Shop API surface. Exposes the
 * pre-pricelist price (for `~~original~~ adjusted` rendering) and a
 * public marketing badge for the winning pricelist. Internal ids are
 * never exposed — only the list `code` and a human-readable `label`
 * (sourced from `PriceList.name`).
 */
export const shopApiExtensions = gql`
    extend type ProductVariant {
        """
        The variant's price before any pricelist applied. Null when no
        pricelist applies. Storefronts render strike-through pricing when
        \`originalPrice\` is non-null.
        """
        originalPrice: Int
        originalPriceWithTax: Int
        """
        Public marketing metadata about the winning (highest-priority)
        pricelist. Null when none applies or when disabled via
        \`exposeBadgeOnShopApi\`.
        """
        priceListBadge: PriceListBadge
    }

    type PriceListBadge {
        "Stable identifier for storefront i18n (the PriceList code)."
        code: String!
        "Human-readable label (PriceList.name)."
        label: String!
    }
`;

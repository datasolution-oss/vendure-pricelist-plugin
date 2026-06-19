import { defineDashboardExtension } from '@vendure/dashboard';
import { Currency } from 'lucide-react';

import { Trans } from '@lingui/react/macro';
import { PriceListDetailPage } from './pages/price-list-detail';
import { PriceListGroupDetailPage } from './pages/price-list-group-detail';
import { PriceListGroupListPage } from './pages/price-list-group-list';
import { PriceListItemDetailPage } from './pages/price-list-item-detail';
import { PriceListListPage } from './pages/price-list-list';

import { VariantPriceListBlock } from './components/variant-pricelist-block';

// NOTE on the /* i18n */ markers below: these strings live at module
// scope (Vendure's nav/breadcrumb renderer reads them and calls
// `i18n.t(string)` at render time). Lingui's macro can't transform
// template literals here because there's no hook context. The
// `/* i18n */` comment tells Lingui's extractor to include each string
// in the catalog as if it were `t`…``. Without the markers, the string
// is in the source but absent from the .po file, so French/German
// locales fall back to the English source.

defineDashboardExtension({
  navSections: [
    {
      id: 'pricing',
      title: /* i18n */ 'Pricing',
      icon: Currency,
      placement: 'top'
    }
  ],
  routes: [
    {
      path: '/pricelists',
      loader: () => ({ breadcrumb: /* i18n */ 'Pricelists' }),
      navMenuItem: {
        id: 'pricelists',
        title: /* i18n */ 'Pricelists',
        sectionId: 'pricing',
        // Hide the menu item from users without read access. The API
        // is independently @Allow-guarded, so a direct URL hit still
        // fails — this just keeps the nav clean per role.
        requiresPermission: 'ReadPriceList'
      },
      component: route => <PriceListListPage route={route} />
    },
    {
      path: '/pricelists/$id',
      // Optional origin carried from the variant page's "associated
      // pricelists" table, so we can render a breadcrumb back to that
      // variant (the pricelist page is otherwise not tied to a product).
      validateSearch: (search: Record<string, unknown>) => ({
        fromVariantId: search.fromVariantId ? String(search.fromVariantId) : undefined,
        fromVariantName: search.fromVariantName ? String(search.fromVariantName) : undefined
      }),
      loader: ({ location }: any) => {
        const s = location?.search ?? {};
        if (s.fromVariantId) {
          return {
            breadcrumb: [
              {
                label: s.fromVariantName || /* i18n */ 'Variant',
                path: `/product-variants/${s.fromVariantId}`
              },
              /* i18n */ 'Pricelist'
            ]
          };
        }
        return { breadcrumb: /* i18n */ 'Pricelist' };
      },
      component: () => <PriceListDetailPage />
    },
    {
      // Per-variant pivot editor for a pricelist item. The
      // `variantId` segment is the ProductVariant id — a single
      // (priceList, variant) pair maps to N PriceListItem rows
      // (one per currency × stepQuantity cell of the pivot).
      path: '/pricelists/$id/items/$variantId',
      loader: () => ({ breadcrumb: /* i18n */ 'Item' }),
      component: () => <PriceListItemDetailPage />
    },
    {
      path: '/pricelist-groups',
      loader: () => ({ breadcrumb: /* i18n */ 'Pricelist Groups' }),
      navMenuItem: {
        id: 'pricelist-groups',
        title: /* i18n */ 'Groups',
        sectionId: 'pricing',
        requiresPermission: 'ReadPriceListGroup'
      },
      component: route => <PriceListGroupListPage route={route} />
    },
    {
      path: '/pricelist-groups/$id',
      loader: () => ({ breadcrumb: /* i18n */ 'Pricelist Group' }),
      component: () => <PriceListGroupDetailPage />
    }
  ],
  pageBlocks: [
    {
      id: 'pricelist-variant-pricing',
      title: <Trans>Pricelists & simulator</Trans>,
      location: {
        pageId: 'product-variant-detail',
        position: { blockId: 'price-and-tax', order: 'after' },
        column: 'main'
      },
      // Read-only inspection block; the backing admin queries are
      // independently @Allow(ReadPriceList)-guarded.
      requiresPermission: 'ReadPriceList',
      component: VariantPriceListBlock
    }
  ],
  actionBarItems: [],
  alerts: [],
  widgets: [],
  customFormComponents: {},
  dataTables: [],
  detailForms: [],
  login: {},
  historyEntries: []
});

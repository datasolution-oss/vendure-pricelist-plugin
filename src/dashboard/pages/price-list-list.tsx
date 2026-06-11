import { DateTime } from '@/vdb/components/data-display/date-time.js';
import { DetailPageButton } from '@/vdb/components/shared/detail-page-button.js';
import { Badge } from '@/vdb/components/ui/badge.js';
import { Label } from '@/vdb/components/ui/label.js';
import { Switch } from '@/vdb/components/ui/switch.js';
import { ListPage } from '@/vdb/framework/page/list-page.js';
import { useLingui } from '@lingui/react/macro';
import { AnyRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { ChannelCodeLabel } from '@/vdb/index';
import { CreatePriceListDialog } from '../components/create-price-list-dialog';
import { DeletePriceListBulkAction, RestorePriceListBulkAction } from '../components/delete-price-list-bulk-action';
import { priceListsListQuery } from '../gql/queries';

interface PriceListListPageProps {
  route: AnyRoute;
}

export function PriceListListPage({ route }: Readonly<PriceListListPageProps>) {
  const { t } = useLingui();
  // "Show pending deletion" toggle: surfaces soft-deleted lists that
  // are still in their grace period (Stage 1E). Off by default —
  // the canonical list view matches Stage 1B behavior.
  const [showPending, setShowPending] = useState(false);
  // PaginatedListDataTable keys its react-query cache on a constant +
  // the DocumentNode, so a predicate matching the operation-name
  // string never fires. Use the table's own refetch fn instead.
  const refresh = useRef<() => void>(() => {});

  // `includeDeleted` is injected via transformVariables, but it is NOT
  // part of the data-table's query key — so flipping the toggle alone
  // won't refetch (react-query serves the cached page). Force a
  // refetch when the toggle changes; refetch always re-runs the
  // latest queryFn, which picks up the new includeDeleted value.
  useEffect(() => {
    refresh.current();
  }, [showPending]);

  return (
    <ListPage
      pageId="pricelist-list"
      listQuery={priceListsListQuery as any}
      route={route}
      registerRefresher={fn => (refresh.current = fn)}
      title={t`Pricelists`}
      transformVariables={vars => ({
        ...vars,
        options: {
          ...((vars as any).options ?? {}),
          includeDeleted: showPending
        }
      })}
      // Keep the default-visible set lean so the Actions column is
      // reachable without horizontal scrolling (the Vendure
      // DataTable doesn't support sticky/pinned columns — that
      // would require patching the upstream component). priority /
      // start / end dates / channels / deletedAt stay opt-in via
      // the column-visibility menu. Timezone isn't a column at all
      // (feature on hold) — it's shown read-only on the detail page.
      defaultVisibility={{
        code: true,
        name: true,
        valueType: true,
        enabled: true,
        originChannel: true,
        priority: false,
        startDate: false,
        endDate: false,
        channels: false,
        deletedAt: false
      }}
      onSearchTermChange={(searchTerm: string) => ({ code: { contains: searchTerm } }) as any}
      customizeColumns={
        {
          code: {
            header: t`Code`,
            cell: ({ row }: any) => <DetailPageButton id={row.original.id} label={row.original.code} />
          },
          name: {
            header: t`Name`
          },
          valueType: {
            header: t`Value type`,
            cell: ({ row }: any) => (
              <Badge variant={row.original.valueType === 'PERCENTAGE' ? 'secondary' : 'outline'}>
                {row.original.valueType === 'PERCENTAGE' ? t`Percentage` : t`Absolute`}
              </Badge>
            )
          },
          priority: {
            header: t`Priority`
          },
          enabled: {
            header: t`Status`,
            // `deletedAt` drives the "pending deletion" state but
            // isn't this column's bound field — declare it as a
            // dependency so the field-selection optimiser keeps
            // it in the query even when its own column is hidden.
            meta: { dependencies: ['deletedAt'] },
            cell: ({ row }: any) => {
              if (row.original.deletedAt) {
                return <Badge variant="secondary">{t`Pending deletion`}</Badge>;
              }
              return row.original.enabled ? (
                <Badge variant="success">{t`Enabled`}</Badge>
              ) : (
                <Badge variant="outline">{t`Disabled`}</Badge>
              );
            }
          },
          startDate: {
            header: t`Starts`,
            cell: ({ row }: any) =>
              row.original.startDate ? (
                <DateTime value={row.original.startDate} />
              ) : (
                <span className="text-muted-foreground">∞</span>
              )
          },
          endDate: {
            header: t`Ends`,
            cell: ({ row }: any) =>
              row.original.endDate ? (
                <DateTime value={row.original.endDate} />
              ) : (
                <span className="text-muted-foreground">∞</span>
              )
          },
          deletedAt: {
            header: t`Deleted at`,
            cell: ({ row }: any) =>
              row.original.deletedAt ? (
                <DateTime value={row.original.deletedAt} />
              ) : (
                <span className="text-muted-foreground">—</span>
              )
          },
          originChannel: {
            header: t`Origin channel`,
            // ListPage auto-renders the relation as raw JSON
            // otherwise — pull the code out for display.
            cell: ({ row }: any) => (
              <code className="text-xs">
                <ChannelCodeLabel code={row.original.originChannel?.code ?? '—'} />
              </code>
            )
          },
          channels: {
            header: t`Channels`,
            // Render each channel with `ChannelCodeLabel` (the same
            // component used elsewhere in the dashboard) instead of raw
            // JSON. Without a custom cell ListPage dumps the relation
            // array; Vendure channels have no `name`, so the code-label
            // is the human-readable identifier.
            cell: ({ row }: any) => {
              const channels = (row.original.channels ?? []) as Array<{ id: string; code: string }>;
              return channels.length ? (
                <span className="flex flex-wrap items-center gap-1">
                  {channels.map(c => (
                    <ChannelCodeLabel key={c.id} code={c.code} />
                  ))}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              );
            }
          }
        } as any
      }
      bulkActions={[[{ component: DeletePriceListBulkAction }, { component: RestorePriceListBulkAction }]]}
    >
      {/*
              ListPage renders `children` in the PageActionBar slot
              (alongside the create button). The pending-deletion toggle
              sits next to "New Pricelist" so the merchandiser can flip
              it on, see deleted lists with the Pending badge, and click
              the Restore action.
            */}
      <div className="flex items-center gap-2">
        <Switch id="show-pending-toggle" checked={showPending} onCheckedChange={setShowPending} />
        <Label htmlFor="show-pending-toggle" className="text-sm cursor-pointer">
          {t`Show pending deletion`}
        </Label>
      </div>
      <CreatePriceListDialog onCreated={() => refresh.current()} />
    </ListPage>
  );
}

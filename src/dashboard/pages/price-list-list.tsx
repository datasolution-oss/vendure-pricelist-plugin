import { Badge } from '@/vdb/components/ui/badge.js';
import { Label } from '@/vdb/components/ui/label.js';
import { Switch } from '@/vdb/components/ui/switch.js';
import { BooleanDisplayBadge } from '@/vdb/components/data-display/boolean.js';
import { DateTime } from '@/vdb/components/data-display/date-time.js';
import { DetailPageButton } from '@/vdb/components/shared/detail-page-button.js';
import { ListPage } from '@/vdb/framework/page/list-page.js';
import { api } from '@/vdb/graphql/api.js';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AnyRoute } from '@tanstack/react-router';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { CreatePriceListDialog } from '../components/create-price-list-dialog';
import { DeletePriceListBulkAction } from '../components/delete-price-list-bulk-action';
import { restorePriceListMutation } from '../gql/mutations';
import { priceListsListQuery } from '../gql/queries';

interface PriceListListPageProps {
    route: AnyRoute;
}

export function PriceListListPage({ route }: Readonly<PriceListListPageProps>) {
    const { t } = useLingui();
    const queryClient = useQueryClient();
    // "Show pending deletion" toggle: surfaces soft-deleted lists that
    // are still in their grace period (Stage 1E). Off by default —
    // the canonical list view matches Stage 1B behavior.
    const [showPending, setShowPending] = useState(false);

    const restoreMutation = useMutation({
        mutationFn: (id: string) =>
            api.mutate(restorePriceListMutation, { id } as any),
        onSuccess: () => {
            toast.success(t`Pricelist restored`);
            // PaginatedListDataTable (inside ListPage) keys its cache by
            // the query name; invalidate by substring match so we don't
            // need to know the exact key.
            queryClient.invalidateQueries({
                predicate: q =>
                    Array.isArray(q.queryKey) &&
                    q.queryKey.some(
                        seg =>
                            typeof seg === 'string' && seg.includes('priceLists'),
                    ),
            });
        },
        onError: err => {
            console.error('[pricelist] restorePriceList failed:', err);
            toast.error(t`Failed to restore pricelist`);
        },
    });

    return (
        <ListPage
            pageId="pricelist-list"
            listQuery={priceListsListQuery as any}
            route={route}
            title={t`Pricelists`}
            transformVariables={vars => ({
                ...vars,
                options: {
                    ...((vars as any).options ?? {}),
                    includeDeleted: showPending,
                },
            })}
            defaultVisibility={{
                code: true,
                name: true,
                valueType: true,
                originChannel: true,
                priority: true,
                enabled: true,
                startDate: true,
                endDate: true,
                deletedAt: false,
            }}
            onSearchTermChange={(searchTerm: string) =>
                ({ code: { contains: searchTerm } }) as any
            }
            rowActions={[
                {
                    label: (
                        <span className="flex items-center gap-2">
                            <RotateCcw className="h-4 w-4" />
                            {t`Restore`}
                        </span>
                    ),
                    onClick: (row: any) => {
                        // Idempotent on the server, but we short-circuit
                        // client-side too: clicking Restore on an active
                        // pricelist is almost certainly a misclick, so
                        // surface a hint rather than a generic success
                        // toast.
                        if (!row.original.deletedAt) {
                            toast.info(t`Pricelist is already active.`);
                            return;
                        }
                        restoreMutation.mutate(row.original.id);
                    },
                },
            ]}
            customizeColumns={
                {
                    code: {
                        header: t`Code`,
                        cell: ({ row }: any) => (
                            <div className="flex items-center gap-2">
                                <DetailPageButton
                                    id={row.original.id}
                                    label={row.original.code}
                                />
                                {row.original.deletedAt && (
                                    <Badge variant="secondary">
                                        {t`Pending deletion`}
                                    </Badge>
                                )}
                            </div>
                        ),
                    },
                    name: {
                        header: t`Name`,
                    },
                    valueType: {
                        header: t`Value type`,
                        cell: ({ row }: any) => (
                            <Badge
                                variant={
                                    row.original.valueType === 'PERCENTAGE'
                                        ? 'secondary'
                                        : 'outline'
                                }
                            >
                                {row.original.valueType === 'PERCENTAGE'
                                    ? t`Percentage`
                                    : t`Absolute`}
                            </Badge>
                        ),
                    },
                    timezone: {
                        header: t`Timezone`,
                    },
                    priority: {
                        header: t`Priority`,
                    },
                    enabled: {
                        header: t`Enabled`,
                        cell: ({ row }: any) => (
                            <BooleanDisplayBadge value={row.original.enabled} />
                        ),
                    },
                    startDate: {
                        header: t`Starts`,
                        cell: ({ row }: any) =>
                            row.original.startDate ? (
                                <DateTime value={row.original.startDate} />
                            ) : (
                                <span className="text-muted-foreground">∞</span>
                            ),
                    },
                    endDate: {
                        header: t`Ends`,
                        cell: ({ row }: any) =>
                            row.original.endDate ? (
                                <DateTime value={row.original.endDate} />
                            ) : (
                                <span className="text-muted-foreground">∞</span>
                            ),
                    },
                    deletedAt: {
                        header: t`Deleted at`,
                        cell: ({ row }: any) =>
                            row.original.deletedAt ? (
                                <DateTime value={row.original.deletedAt} />
                            ) : (
                                <span className="text-muted-foreground">—</span>
                            ),
                    },
                    originChannel: {
                        header: t`Origin channel`,
                        // ListPage auto-renders the relation as raw JSON
                        // otherwise — pull the code out for display.
                        cell: ({ row }: any) => (
                            <code className="text-xs">
                                {row.original.originChannel?.code ?? '—'}
                            </code>
                        ),
                    },
                    channels: {
                        header: t`Channels`,
                        cell: ({ row }: any) => (
                            <div className="flex flex-wrap gap-1">
                                {(row.original.channels ?? []).map((c: any) => (
                                    <code key={c.id} className="text-xs">
                                        {c.code}
                                    </code>
                                ))}
                            </div>
                        ),
                    },
                } as any
            }
            bulkActions={[[{ component: DeletePriceListBulkAction }]]}
        >
            {/*
              ListPage renders `children` in the PageActionBar slot
              (alongside the create button). The pending-deletion toggle
              sits next to "New Pricelist" so the merchandiser can flip
              it on, see deleted lists with the Pending badge, and click
              the Restore action.
            */}
            <div className="flex items-center gap-2">
                <Switch
                    id="show-pending-toggle"
                    checked={showPending}
                    onCheckedChange={setShowPending}
                />
                <Label
                    htmlFor="show-pending-toggle"
                    className="text-sm cursor-pointer"
                >
                    {t`Show pending deletion`}
                </Label>
            </div>
            <CreatePriceListDialog />
        </ListPage>
    );
}

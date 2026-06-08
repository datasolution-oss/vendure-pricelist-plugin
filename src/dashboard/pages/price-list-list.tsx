import { Badge } from '@/vdb/components/ui/badge.js';
import { BooleanDisplayBadge } from '@/vdb/components/data-display/boolean.js';
import { DateTime } from '@/vdb/components/data-display/date-time.js';
import { DetailPageButton } from '@/vdb/components/shared/detail-page-button.js';
import { ListPage } from '@/vdb/framework/page/list-page.js';
import { useLingui } from '@lingui/react/macro';
import { AnyRoute } from '@tanstack/react-router';

import { CreatePriceListDialog } from '../components/create-price-list-dialog';
import { DeletePriceListBulkAction } from '../components/delete-price-list-bulk-action';
import { priceListsListQuery } from '../gql/queries';

interface PriceListListPageProps {
    route: AnyRoute;
}

export function PriceListListPage({ route }: Readonly<PriceListListPageProps>) {
    const { t } = useLingui();
    return (
        <ListPage
            pageId="pricelist-list"
            listQuery={priceListsListQuery as any}
            route={route}
            title={t`Pricelists`}
            defaultVisibility={{
                code: true,
                name: true,
                valueType: true,
                originChannel: true,
                priority: true,
                enabled: true,
                startDate: true,
                endDate: true,
            }}
            onSearchTermChange={(searchTerm: string) =>
                ({ code: { contains: searchTerm } }) as any
            }
            customizeColumns={
                {
                    code: {
                        header: t`Code`,
                        cell: ({ row }: any) => (
                            <DetailPageButton
                                id={row.original.id}
                                label={row.original.code}
                            />
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
            <CreatePriceListDialog />
        </ListPage>
    );
}

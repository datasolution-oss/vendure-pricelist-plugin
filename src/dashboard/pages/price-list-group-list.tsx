import { BooleanDisplayBadge } from '@/vdb/components/data-display/boolean.js';
import { DetailPageButton } from '@/vdb/components/shared/detail-page-button.js';
import { ListPage } from '@/vdb/framework/page/list-page.js';
import { useLingui } from '@lingui/react/macro';
import { AnyRoute } from '@tanstack/react-router';
import { useRef } from 'react';

import { CreatePriceListGroupDialog } from '../components/create-price-list-group-dialog';
import { DeletePriceListGroupBulkAction } from '../components/delete-price-list-bulk-action';
import { priceListGroupsListQuery } from '../gql/queries';

interface PriceListGroupListPageProps {
    route: AnyRoute;
}

export function PriceListGroupListPage({ route }: Readonly<PriceListGroupListPageProps>) {
    const { t } = useLingui();
    // PaginatedListDataTable (inside ListPage) keys its react-query cache
    // on a constant + the DocumentNode, so a manual
    // invalidateQueries({ queryKey: [...] }) from the create dialog never
    // matches. Capture the table's own refetch fn via registerRefresher
    // and hand it to the dialog so a freshly-created group shows without
    // a manual page refresh.
    const refresh = useRef<() => void>(() => {});

    return (
        <ListPage
            pageId="pricelist-group-list"
            listQuery={priceListGroupsListQuery as any}
            route={route}
            registerRefresher={fn => (refresh.current = fn)}
            title={t`Pricelist Groups`}
            defaultVisibility={{
                code: true,
                name: true,
                channel: true,
                priority: true,
                isDefault: true,
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
                    priority: {
                        header: t`Priority`,
                    },
                    isDefault: {
                        header: t`Default`,
                        cell: ({ row }: any) => (
                            <BooleanDisplayBadge value={row.original.isDefault} />
                        ),
                    },
                    channel: {
                        header: t`Channel`,
                        // ListPage renders relations as raw JSON otherwise.
                        cell: ({ row }: any) => (
                            <code className="text-xs">
                                {row.original.channel?.code ?? '—'}
                            </code>
                        ),
                    },
                } as any
            }
            bulkActions={[[{ component: DeletePriceListGroupBulkAction }]]}
        >
            <CreatePriceListGroupDialog onCreated={() => refresh.current()} />
        </ListPage>
    );
}

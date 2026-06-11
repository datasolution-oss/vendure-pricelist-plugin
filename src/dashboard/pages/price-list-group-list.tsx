import { Badge } from '@/vdb/components/ui/badge.js';
import { DetailPageButton } from '@/vdb/components/shared/detail-page-button.js';
import { api } from '@/vdb/graphql/api.js';
import { ListPage } from '@/vdb/framework/page/list-page.js';
import { useChannel } from '@/vdb/hooks/use-channel.js';
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { AnyRoute } from '@tanstack/react-router';
import { useRef } from 'react';

import { CreatePriceListGroupDialog } from '../components/create-price-list-group-dialog';
import { DeletePriceListGroupBulkAction } from '../components/delete-price-list-bulk-action';
import {
    priceListDefaultGroupQuery,
    priceListGroupsListQuery,
} from '../gql/queries';

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

    // Groups are listed for the active channel; the "default" is now a
    // channel-side fact (no `isDefault` flag on the group), so resolve the
    // active channel's default group id to annotate its row.
    const { activeChannel } = useChannel();
    const activeChannelId = activeChannel ? String(activeChannel.id) : undefined;
    const { data: defaultGroupData } = useQuery({
        queryKey: ['pricelist-default-group', activeChannelId],
        enabled: !!activeChannelId,
        queryFn: () =>
            api.query(priceListDefaultGroupQuery, {
                channelId: activeChannelId!,
            } as any) as Promise<{ priceListDefaultGroup: { id: string } | null }>,
    });
    const defaultGroupId = defaultGroupData?.priceListDefaultGroup?.id;

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
                priority: true,
            }}
            onSearchTermChange={(searchTerm: string) =>
                ({ code: { contains: searchTerm } }) as any
            }
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
                                {row.original.id === defaultGroupId && (
                                    <Badge variant="secondary">{t`default`}</Badge>
                                )}
                            </div>
                        ),
                    },
                    name: {
                        header: t`Name`,
                    },
                    priority: {
                        header: t`Priority`,
                    },
                } as any
            }
            bulkActions={[[{ component: DeletePriceListGroupBulkAction }]]}
        >
            <CreatePriceListGroupDialog onCreated={() => refresh.current()} />
        </ListPage>
    );
}

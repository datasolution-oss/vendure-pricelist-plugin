import { Badge } from '@/vdb/components/ui/badge.js';
import { Button } from '@/vdb/components/ui/button.js';
import { Input } from '@/vdb/components/ui/input.js';
import { Label } from '@/vdb/components/ui/label.js';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/vdb/components/ui/table.js';
import { BooleanDisplayBadge } from '@/vdb/components/data-display/boolean.js';
import { DetailPageButton } from '@/vdb/components/shared/detail-page-button.js';
import { api } from '@/vdb/graphql/api.js';
import {
    Page,
    PageActionBar,
    PageActionBarRight,
    PageBlock,
    PageLayout,
    PageTitle,
} from '@/vdb/framework/layout-engine/page-layout.js';
import { useChannel } from '@/vdb/hooks/use-channel.js';
import { useUserSettings } from '@/vdb/hooks/use-user-settings.js';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { updatePriceListGroupMutation } from '../gql/mutations';
import {
    priceListDefaultGroupQuery,
    priceListGroupDetailQuery,
    priceListsByGroupQuery,
} from '../gql/queries';
import type {
    PriceListGroupDetailResult,
    PriceListsByGroupResult,
} from '../gql/types';

export function PriceListGroupDetailPage() {
    const { t } = useLingui();
    const queryClient = useQueryClient();
    const params = useParams({ strict: false }) as { id?: string };
    const id = params.id;
    // Active content language drives which translation row name/etc.
    // hydrate from and which row the mutation writes. Same convention
    // as the pricelist detail page.
    const { settings } = useUserSettings();
    const contentLanguage = settings.contentLanguage;

    const { data, isLoading, error } = useQuery({
        queryKey: ['pricelist-group', id, contentLanguage],
        queryFn: () =>
            api.query(priceListGroupDetailQuery, {
                id: id!,
            }) as Promise<PriceListGroupDetailResult>,
        enabled: !!id,
    });

    const g = data?.priceListGroup ?? null;

    // Default-for-channel is now a channel-side fact; resolve the active
    // channel's default group id to display whether this group is it.
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
    const isDefaultForActiveChannel =
        !!g && !!defaultGroupData?.priceListDefaultGroup &&
        g.id === defaultGroupData.priceListDefaultGroup.id;

    const [code, setCode] = useState('');
    const [name, setName] = useState('');
    const [priority, setPriority] = useState(0);

    useEffect(() => {
        if (!g) return;
        setCode(g.code);
        setPriority(g.priority);
        // Prefer the translation row for the active content language,
        // falling back to the server-translated name on cold-start
        // (when no row exists yet for that language).
        const tr = g.translations.find(x => x.languageCode === contentLanguage);
        setName(tr?.name ?? g.name);
    }, [g, contentLanguage]);

    const saveMutation = useMutation({
        mutationFn: () =>
            api.mutate(updatePriceListGroupMutation, {
                input: {
                    id: g!.id,
                    code,
                    priority,
                    translations: [{ languageCode: contentLanguage, name }],
                },
            } as any),
        onSuccess: () => {
            toast.success(t`Saved`);
            queryClient.invalidateQueries({ queryKey: ['pricelist-group', id] });
        },
        onError: err => {
            console.error('[pricelist] updatePriceListGroup failed:', err);
            toast.error(t`Failed to save`);
        },
    });

    if (isLoading) {
        return <div className="text-sm text-muted-foreground">{t`Loading…`}</div>;
    }
    if (error) {
        console.error('[pricelist] group detail query failed:', error);
        return (
            <div className="text-sm text-destructive">{t`Failed to load group.`}</div>
        );
    }
    if (!g) {
        return (
            <div className="text-sm text-muted-foreground">{t`Group not found.`}</div>
        );
    }

    return (
        <Page pageId="pricelist-group-detail">
            <PageTitle>{g.name}</PageTitle>
            <PageActionBar>
                <PageActionBarRight>
                    <Button
                        onClick={() => saveMutation.mutate()}
                        disabled={saveMutation.isPending}
                    >
                        <Save className="h-4 w-4 mr-1" />
                        {t`Save`}
                    </Button>
                </PageActionBarRight>
            </PageActionBar>
            <PageLayout>
                {/*
                  `PageBlock` already renders its own bordered card with
                  CardHeader/CardContent — passing `title` plus content
                  directly avoids the double-border anti-pattern.
                */}
                <PageBlock column="main" blockId="group-summary" title={t`Summary`}>
                    <div className="space-y-4">
                        <FormRow label={t`Code`}>
                            <Input
                                value={code}
                                onChange={e => setCode(e.target.value)}
                            />
                        </FormRow>
                        {/*
                          Name is Translatable; we edit it for the active
                          content language (selected via the top-bar
                          language picker), so the field is plain "Name"
                          without a locale suffix.
                        */}
                        <FormRow label={t`Name`}>
                            <Input
                                value={name}
                                onChange={e => setName(e.target.value)}
                            />
                        </FormRow>
                        <FormRow label={t`Priority`}>
                            <Input
                                type="number"
                                value={priority}
                                onChange={e =>
                                    setPriority(parseInt(e.target.value, 10) || 0)
                                }
                            />
                        </FormRow>
                        <FormRow label={t`Channels`}>
                            <span className="flex flex-wrap gap-1">
                                {g.channels.length > 0 ? (
                                    g.channels.map(c => (
                                        <code key={c.id} className="text-sm">
                                            {c.code}
                                        </code>
                                    ))
                                ) : (
                                    <span className="text-muted-foreground">—</span>
                                )}
                            </span>
                        </FormRow>
                        <FormRow label={t`Default for active channel`}>
                            {isDefaultForActiveChannel ? (
                                <Badge variant="success">{t`Yes`}</Badge>
                            ) : (
                                <Badge variant="secondary">{t`No`}</Badge>
                            )}
                        </FormRow>
                    </div>
                </PageBlock>
                {/*
                  Translations block intentionally removed — inline editing
                  of `Name` above writes to the active language's
                  translation row. See PLAN-STAGE-1 §"Stage 1D refactor"
                  for the equivalent change on the pricelist detail page.
                */}

                <PageBlock
                    column="main"
                    blockId="group-pricelists"
                    title={t`Pricelists in this group`}
                >
                    <GroupPricelistsBlock groupId={g.id} />
                </PageBlock>
            </PageLayout>
        </Page>
    );
}

interface GroupPricelistsBlockProps {
    groupId: string;
}

/**
 * Lists the pricelists bound to this group (via the membership
 * pivot), paginated. Read-only — clicking a row navigates to that
 * pricelist's detail page where the binding can be changed.
 */
function GroupPricelistsBlock({ groupId }: Readonly<GroupPricelistsBlockProps>) {
    const { t } = useLingui();
    const [page, setPage] = useState(0);
    const pageSize = 10;

    const { data, isLoading } = useQuery({
        queryKey: ['pricelists-by-group', groupId, page],
        queryFn: () =>
            api.query(priceListsByGroupQuery, {
                groupId,
                options: { skip: page * pageSize, take: pageSize },
            } as any) as Promise<PriceListsByGroupResult>,
    });

    const items = data?.priceListsByGroup.items ?? [];
    const totalItems = data?.priceListsByGroup.totalItems ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

    if (isLoading) {
        return <p className="text-sm text-muted-foreground">{t`Loading…`}</p>;
    }
    if (items.length === 0) {
        return (
            <p className="text-sm text-muted-foreground">
                {t`No pricelists in this group yet.`}
            </p>
        );
    }

    return (
        <div className="space-y-3">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>{t`Code`}</TableHead>
                        <TableHead>{t`Name`}</TableHead>
                        <TableHead>{t`Value type`}</TableHead>
                        <TableHead>{t`Origin channel`}</TableHead>
                        <TableHead>{t`Enabled`}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {items.map(pl => (
                        <TableRow key={pl.id}>
                            <TableCell>
                                <DetailPageButton id={pl.id} label={pl.code} />
                            </TableCell>
                            <TableCell>{pl.name}</TableCell>
                            <TableCell>
                                <Badge
                                    variant={
                                        pl.valueType === 'PERCENTAGE'
                                            ? 'secondary'
                                            : 'outline'
                                    }
                                >
                                    {pl.valueType === 'PERCENTAGE'
                                        ? t`Percentage`
                                        : t`Absolute`}
                                </Badge>
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                                {pl.originChannel?.code ?? '—'}
                            </TableCell>
                            <TableCell>
                                <BooleanDisplayBadge value={pl.enabled} />
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>

            {totalPages > 1 && (
                <div className="flex items-center justify-end gap-2">
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setPage(p => Math.max(0, p - 1))}
                        disabled={page === 0}
                        aria-label={t`Previous page`}
                    >
                        <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-xs">
                        {page + 1} / {totalPages}
                    </span>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                        disabled={page >= totalPages - 1}
                        aria-label={t`Next page`}
                    >
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            )}
        </div>
    );
}

function FormRow({
    label,
    children,
}: Readonly<{ label: string; children: React.ReactNode }>) {
    return (
        <div className="grid grid-cols-[160px_1fr] items-center gap-3">
            <Label className="text-muted-foreground">{label}</Label>
            <div>{children}</div>
        </div>
    );
}

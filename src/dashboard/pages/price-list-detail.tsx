import { Badge } from '@/vdb/components/ui/badge.js';
import { Button } from '@/vdb/components/ui/button.js';
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from '@/vdb/components/ui/card.js';
import { Input } from '@/vdb/components/ui/input.js';
import { Label } from '@/vdb/components/ui/label.js';
import { Switch } from '@/vdb/components/ui/switch.js';
import { Textarea } from '@/vdb/components/ui/textarea.js';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/vdb/components/ui/table.js';
import { ConfirmationDialog } from '@/vdb/components/shared/confirmation-dialog.js';
import { api } from '@/vdb/graphql/api.js';
import {
    Page,
    PageActionBar,
    PageActionBarRight,
    PageBlock,
    PageLayout,
    PageTitle,
} from '@/vdb/framework/layout-engine/page-layout.js';
import { useUserSettings } from '@/vdb/hooks/use-user-settings.js';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PriceListAccessBlock } from '../components/price-list-access-block';
import { PriceListItemsGrid } from '../components/price-list-items-grid';
import { ReadOnlyBanner } from '../components/read-only-banner';
import { ShareToChannelDialog } from '../components/share-to-channel-dialog';
import {
    deletePriceListMutation,
    removePriceListFromChannelMutation,
    updatePriceListMutation,
} from '../gql/mutations';
import { priceListDetailQuery } from '../gql/queries';
import type { PriceListDetailResult } from '../gql/types';
import { useIsEditable } from '../lib/use-is-editable';

export function PriceListDetailPage() {
    const { t } = useLingui();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const params = useParams({ strict: false }) as { id?: string };
    const id = params.id;
    // The dashboard's content language picker (top-bar) drives which
    // translation row we read/write. Same language is sent on every
    // mutation by the API client, so we just mirror that here for the
    // label and for resolving the right translation row to hydrate.
    const { settings } = useUserSettings();
    const contentLanguage = settings.contentLanguage;

    const { data, isLoading, error } = useQuery({
        queryKey: ['pricelist', id, contentLanguage],
        queryFn: () =>
            api.query(priceListDetailQuery, { id: id! }) as Promise<PriceListDetailResult>,
        enabled: !!id,
    });

    const pl = data?.priceList ?? null;
    const isEditable = useIsEditable(pl?.originChannel.id);

    // Editable form draft, hydrated from the loaded entity.
    const [code, setCode] = useState('');
    const [priority, setPriority] = useState(0);
    const [enabled, setEnabled] = useState(true);
    const [startDate, setStartDate] = useState<string>('');
    const [endDate, setEndDate] = useState<string>('');
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');

    useEffect(() => {
        if (!pl) return;
        setCode(pl.code);
        setPriority(pl.priority);
        setEnabled(pl.enabled);
        setStartDate(pl.startDate ? pl.startDate.slice(0, 16) : '');
        setEndDate(pl.endDate ? pl.endDate.slice(0, 16) : '');
        // Prefer a translation matching the active content language, falling
        // back to the value already resolved by the server's translator
        // (handles "no translation row yet for this language" gracefully).
        const tr = pl.translations.find(x => x.languageCode === contentLanguage);
        setName(tr?.name ?? pl.name);
        setDescription(tr?.description ?? pl.description ?? '');
    }, [pl, contentLanguage]);

    const saveMutation = useMutation({
        mutationFn: () =>
            api.mutate(updatePriceListMutation, {
                input: {
                    id: pl!.id,
                    code,
                    priority,
                    enabled,
                    startDate: startDate ? new Date(startDate).toISOString() : null,
                    endDate: endDate ? new Date(endDate).toISOString() : null,
                    translations: [
                        {
                            languageCode: contentLanguage,
                            name,
                            description,
                        },
                    ],
                },
            } as any),
        onSuccess: () => {
            toast.success(t`Saved`);
            queryClient.invalidateQueries({ queryKey: ['pricelist', id] });
        },
        onError: err => {
            console.error('[pricelist] updatePriceList failed:', err);
            toast.error(t`Failed to save`);
        },
    });

    const deleteMutation = useMutation({
        mutationFn: () => api.mutate(deletePriceListMutation, { id: pl!.id } as any),
        onSuccess: () => {
            toast.success(t`Pricelist deleted`);
            queryClient.invalidateQueries({ queryKey: ['pricelists', 'list'] });
            navigate({ to: '/pricelists' });
        },
        onError: err => {
            console.error('[pricelist] deletePriceList failed:', err);
            toast.error(t`Failed to delete`);
        },
    });

    const unshareMutation = useMutation({
        mutationFn: (channelId: string) =>
            api.mutate(removePriceListFromChannelMutation, {
                priceListId: pl!.id,
                channelId,
            } as any),
        onSuccess: () => {
            toast.success(t`Stopped sharing`);
            queryClient.invalidateQueries({ queryKey: ['pricelist', id] });
        },
        onError: err => {
            console.error('[pricelist] removePriceListFromChannel failed:', err);
            toast.error(t`Failed to stop sharing`);
        },
    });

    if (isLoading) {
        return <div className="text-sm text-muted-foreground">{t`Loading…`}</div>;
    }
    if (error) {
        console.error('[pricelist] detail query failed:', error);
        return (
            <div className="text-sm text-destructive">{t`Failed to load pricelist.`}</div>
        );
    }
    if (!pl) {
        return <div className="text-sm text-muted-foreground">{t`PriceList not found.`}</div>;
    }

    const sharedChannels = pl.channels.filter(c => c.id !== pl.originChannel.id);

    return (
        <Page pageId="pricelist-detail">
            <PageTitle>{pl.name}</PageTitle>

            {!isEditable && <ReadOnlyBanner originChannelCode={pl.originChannel.code} />}

            <PageActionBar>
                <PageActionBarRight>
                    <ShareToChannelDialog
                        priceListId={pl.id}
                        excludeChannelIds={pl.channels.map(c => c.id)}
                        disabled={!isEditable}
                    />
                    <ConfirmationDialog
                        title={t`Delete this pricelist?`}
                        description={t`The pricelist will be soft-deleted. Items remain in the database but become invisible. This cannot be undone from the dashboard.`}
                        confirmText={t`Delete`}
                        onConfirm={() => deleteMutation.mutate()}
                    >
                        <Button variant="destructive" disabled={!isEditable}>
                            <Trash2 className="h-4 w-4 mr-1" />
                            {t`Delete`}
                        </Button>
                    </ConfirmationDialog>
                    <Button
                        onClick={() => saveMutation.mutate()}
                        disabled={!isEditable || saveMutation.isPending}
                    >
                        <Save className="h-4 w-4 mr-1" />
                        {t`Save`}
                    </Button>
                </PageActionBarRight>
            </PageActionBar>

            <PageLayout>
                <PageBlock column="main" blockId="pricelist-summary">
                    <Card>
                        <CardHeader>
                            <CardTitle>{t`Summary`}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <FormRow label={t`Code`}>
                                <Input
                                    value={code}
                                    onChange={e => setCode(e.target.value)}
                                    disabled={!isEditable}
                                />
                            </FormRow>
                            {/*
                              Name and description are Translatable on the
                              entity. Editing them writes to the translation
                              row for the active content language of the
                              dashboard — no separate "Translations" block.
                              The active language is already shown by the
                              channel-language picker in the top bar, so the
                              labels stay plain (no `(FR)` / `(EN)` suffix).
                            */}
                            <FormRow label={t`Name`}>
                                <Input
                                    value={name}
                                    onChange={e => setName(e.target.value)}
                                    disabled={!isEditable}
                                />
                            </FormRow>
                            <FormRow label={t`Description`}>
                                <Textarea
                                    value={description}
                                    onChange={e => setDescription(e.target.value)}
                                    disabled={!isEditable}
                                    rows={3}
                                />
                            </FormRow>
                            <FormRow label={t`Value type`}>
                                <div className="flex items-center gap-2">
                                    <Badge
                                        variant={
                                            pl.valueType === 'PERCENTAGE'
                                                ? 'secondary'
                                                : 'outline'
                                        }
                                    >
                                        {pl.valueType === 'PERCENTAGE'
                                            ? t`Percentage discounts`
                                            : t`Absolute prices`}
                                    </Badge>
                                    <span className="text-xs text-muted-foreground">
                                        {t`Locked once created.`}
                                    </span>
                                </div>
                            </FormRow>
                            {/* Timezone field intentionally hidden — see plan
                                Stage 1D §"timezone on hold". The DB column
                                still exists (defaults to UTC); re-enable by
                                mounting TimezoneSelect when Stage-2 lookup
                                consumes it. */}
                            <FormRow label={t`Priority`}>
                                <Input
                                    type="number"
                                    value={priority}
                                    onChange={e =>
                                        setPriority(parseInt(e.target.value, 10) || 0)
                                    }
                                    disabled={!isEditable}
                                />
                            </FormRow>
                            <FormRow label={t`Enabled`}>
                                <Switch
                                    checked={enabled}
                                    onCheckedChange={setEnabled}
                                    disabled={!isEditable}
                                />
                            </FormRow>
                            <FormRow label={t`Starts`}>
                                <Input
                                    type="datetime-local"
                                    value={startDate}
                                    onChange={e => setStartDate(e.target.value)}
                                    disabled={!isEditable}
                                />
                            </FormRow>
                            <FormRow label={t`Ends`}>
                                <Input
                                    type="datetime-local"
                                    value={endDate}
                                    onChange={e => setEndDate(e.target.value)}
                                    disabled={!isEditable}
                                />
                            </FormRow>
                            <FormRow label={t`Origin channel`}>
                                <code className="text-sm">{pl.originChannel.code}</code>
                            </FormRow>
                        </CardContent>
                    </Card>
                </PageBlock>

                <PageBlock column="main" blockId="pricelist-items">
                    <Card>
                        <CardHeader>
                            <CardTitle>{t`Items`}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <PriceListItemsGrid
                                priceListId={pl.id}
                                valueType={pl.valueType}
                                availableCurrencyCodes={
                                    pl.originChannel.availableCurrencyCodes
                                }
                                defaultCurrencyCode={
                                    pl.originChannel.defaultCurrencyCode
                                }
                                disabled={!isEditable}
                            />
                        </CardContent>
                    </Card>
                </PageBlock>

                <PageBlock column="main" blockId="pricelist-channels">
                    <Card>
                        <CardHeader>
                            <CardTitle>{t`Channel memberships`}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            {pl.groupMemberships.length === 0 ? (
                                <p className="text-sm text-muted-foreground">
                                    {t`Not bound to any channel/group yet.`}
                                </p>
                            ) : (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t`Channel`}</TableHead>
                                            <TableHead>{t`Group`}</TableHead>
                                            <TableHead></TableHead>
                                            <TableHead className="text-right"></TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {pl.groupMemberships.map(m => {
                                            const isOriginRow =
                                                m.group.channel.id === pl.originChannel.id;
                                            return (
                                                <TableRow key={m.id}>
                                                    <TableCell className="font-mono">
                                                        {m.group.channel.code}
                                                    </TableCell>
                                                    <TableCell className="font-mono">
                                                        {m.group.code}
                                                    </TableCell>
                                                    <TableCell>
                                                        {isOriginRow && (
                                                            <Badge variant="success">
                                                                {t`origin`}
                                                            </Badge>
                                                        )}
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        {!isOriginRow && (
                                                            <ConfirmationDialog
                                                                title={t`Stop sharing on this channel?`}
                                                                description={t`The pricelist will no longer be visible on the target channel. Items remain intact.`}
                                                                confirmText={t`Stop sharing`}
                                                                onConfirm={() =>
                                                                    unshareMutation.mutate(
                                                                        m.group.channel.id,
                                                                    )
                                                                }
                                                            >
                                                                <Button
                                                                    variant="ghost"
                                                                    size="sm"
                                                                    disabled={!isEditable}
                                                                >
                                                                    {t`Stop sharing`}
                                                                </Button>
                                                            </ConfirmationDialog>
                                                        )}
                                                    </TableCell>
                                                </TableRow>
                                            );
                                        })}
                                    </TableBody>
                                </Table>
                            )}
                            {sharedChannels.length === 0 && (
                                <p className="mt-2 text-xs text-muted-foreground">
                                    {t`Use "Share to channel" above to make this pricelist available on other channels.`}
                                </p>
                            )}
                        </CardContent>
                    </Card>
                </PageBlock>

                <PageBlock column="main" blockId="pricelist-access">
                    <PriceListAccessBlock
                        priceListId={pl.id}
                        assignedToEveryone={pl.assignedToEveryone}
                        disabled={!isEditable}
                    />
                </PageBlock>
            </PageLayout>
        </Page>
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

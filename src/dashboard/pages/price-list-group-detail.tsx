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
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/vdb/components/ui/table.js';
import { api } from '@/vdb/graphql/api.js';
import {
    Page,
    PageActionBar,
    PageActionBarRight,
    PageBlock,
    PageLayout,
    PageTitle,
} from '@/vdb/framework/layout-engine/page-layout.js';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { updatePriceListGroupMutation } from '../gql/mutations';
import { priceListGroupDetailQuery } from '../gql/queries';
import type { PriceListGroupDetailResult } from '../gql/types';

export function PriceListGroupDetailPage() {
    const { t } = useLingui();
    const queryClient = useQueryClient();
    const params = useParams({ strict: false }) as { id?: string };
    const id = params.id;

    const { data, isLoading, error } = useQuery({
        queryKey: ['pricelist-group', id],
        queryFn: () =>
            api.query(priceListGroupDetailQuery, {
                id: id!,
            }) as Promise<PriceListGroupDetailResult>,
        enabled: !!id,
    });

    const g = data?.priceListGroup ?? null;

    const [code, setCode] = useState('');
    const [name, setName] = useState('');
    const [priority, setPriority] = useState(0);

    useEffect(() => {
        if (!g) return;
        setCode(g.code);
        setPriority(g.priority);
        const enTrans = g.translations.find(t => t.languageCode === 'en');
        setName(enTrans?.name ?? g.name);
    }, [g]);

    const saveMutation = useMutation({
        mutationFn: () =>
            api.mutate(updatePriceListGroupMutation, {
                input: {
                    id: g!.id,
                    code,
                    priority,
                    translations: [{ languageCode: 'en', name }],
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
                <PageBlock column="main" blockId="group-summary">
                    <Card>
                        <CardHeader>
                            <CardTitle>{t`Summary`}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <FormRow label={t`Code`}>
                                <Input
                                    value={code}
                                    onChange={e => setCode(e.target.value)}
                                />
                            </FormRow>
                            <FormRow label={t`Name (English)`}>
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
                            <FormRow label={t`Channel`}>
                                <code className="text-sm">{g.channel.code}</code>
                            </FormRow>
                            <FormRow label={t`Default for channel`}>
                                {g.isDefault ? (
                                    <Badge variant="success">{t`Yes`}</Badge>
                                ) : (
                                    <Badge variant="secondary">{t`No`}</Badge>
                                )}
                            </FormRow>
                        </CardContent>
                    </Card>
                </PageBlock>

                <PageBlock column="main" blockId="group-translations">
                    <Card>
                        <CardHeader>
                            <CardTitle>
                                {t`Translations (${g.translations.length})`}
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            {g.translations.length === 0 ? (
                                <p className="text-sm text-muted-foreground">
                                    {t`No translations yet.`}
                                </p>
                            ) : (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t`Language`}</TableHead>
                                            <TableHead>{t`Name`}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {g.translations.map(tr => (
                                            <TableRow key={tr.id}>
                                                <TableCell>
                                                    <Badge variant="outline">
                                                        {tr.languageCode}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell>{tr.name}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            )}
                            <p className="mt-2 text-xs text-muted-foreground">
                                {t`Translations for other languages can be added via the Admin API.`}
                            </p>
                        </CardContent>
                    </Card>
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

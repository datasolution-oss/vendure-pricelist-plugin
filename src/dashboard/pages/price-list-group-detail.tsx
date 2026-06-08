import { Badge } from '@/vdb/components/ui/badge.js';
import { Button } from '@/vdb/components/ui/button.js';
import { Input } from '@/vdb/components/ui/input.js';
import { Label } from '@/vdb/components/ui/label.js';
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
                    </div>
                </PageBlock>
                {/*
                  Translations block intentionally removed — inline editing
                  of `Name` above writes to the active language's
                  translation row. See PLAN-STAGE-1 §"Stage 1D refactor"
                  for the equivalent change on the pricelist detail page.
                */}
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

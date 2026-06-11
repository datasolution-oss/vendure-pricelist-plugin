import { Badge } from '@/vdb/components/ui/badge.js';
import { Button } from '@/vdb/components/ui/button.js';
import { Input } from '@/vdb/components/ui/input.js';
import { Label } from '@/vdb/components/ui/label.js';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/vdb/components/ui/select.js';
import { MoneyInput } from '@/vdb/components/data-input/money-input.js';
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
import { useNavigate, useParams } from '@tanstack/react-router';
import { Plus, Save, Trash, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { PercentageInput } from '../components/percentage-input';
import { savePriceListVariantPivotMutation } from '../gql/mutations';
import {
    priceListDetailQuery,
    priceListVariantItemsQuery,
} from '../gql/queries';
import type {
    PriceListDetailResult,
    PriceListValueType,
} from '../gql/types';
import { useIsEditable } from '../hooks/use-is-editable';

interface VariantItemRow {
    id: string;
    currencyCode: string;
    stepQuantity: number;
    value: number;
    productVariant: { id: string; name: string; sku: string };
}

interface VariantItemsResult {
    priceListVariantItems: VariantItemRow[];
}

/** A single quantity-tier row inside a currency block. */
interface TierRow {
    stepQuantity: number;
    value: number;
}

/** One currency's prices: an independent ladder of tiers. */
interface CurrencyBlockData {
    currencyCode: string;
    tiers: TierRow[];
}

/**
 * Per-variant price editor for one (priceList, variant) pair.
 *
 * Layout: one bordered block per currency (à la Vendure collection
 * editing), each listing its own quantity-tier ladder (Min qty →
 * price). Tiers are independent per currency — EUR can have tiers
 * 1/5/10 while USD has just 1.
 *
 * Save flattens every block's tiers into the
 * `savePriceListVariantPivot` payload, which diffs insert/update/
 * delete server-side. Composed from Vendure UI primitives so the
 * page reads as native dashboard.
 */
export function PriceListItemDetailPage() {
    const { t } = useLingui();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const params = useParams({ strict: false }) as {
        id?: string;
        variantId?: string;
    };
    const priceListId = params.id;
    const variantId = params.variantId;

    const { data: plData } = useQuery({
        queryKey: ['pricelist', priceListId],
        queryFn: () =>
            api.query(priceListDetailQuery, {
                id: priceListId!,
            }) as Promise<PriceListDetailResult>,
        enabled: !!priceListId,
    });

    const { data: itemsData, isLoading } = useQuery({
        queryKey: ['pricelist-variant-items', priceListId, variantId],
        queryFn: () =>
            api.query(priceListVariantItemsQuery, {
                priceListId: priceListId!,
                productVariantId: variantId!,
            }) as Promise<VariantItemsResult>,
        enabled: !!priceListId && !!variantId,
    });

    const pl = plData?.priceList ?? null;
    const items = itemsData?.priceListVariantItems ?? [];
    const isEditable = useIsEditable(pl?.originChannel.id);

    // Draft = ordered currency blocks. Default currency first, then
    // alphabetical; tiers within a block ascending by stepQuantity.
    const [blocks, setBlocks] = useState<CurrencyBlockData[]>([]);

    // Hydrate from server. Drops local edits on refetch — Save then
    // invalidate is the canonical landing path.
    useEffect(() => {
        if (!pl || !itemsData) return;
        const byCurrency = new Map<string, TierRow[]>();
        items.forEach(it => {
            const tiers = byCurrency.get(it.currencyCode) ?? [];
            tiers.push({ stepQuantity: it.stepQuantity, value: it.value });
            byCurrency.set(it.currencyCode, tiers);
        });
        const ordered = sortCurrencies(
            Array.from(byCurrency.keys()),
            pl.originChannel.defaultCurrencyCode,
        ).map(currencyCode => ({
            currencyCode,
            tiers: (byCurrency.get(currencyCode) ?? []).sort(
                (a, b) => a.stepQuantity - b.stepQuantity,
            ),
        }));
        setBlocks(ordered);
    }, [pl?.id, itemsData]);

    const valueType: PriceListValueType = pl?.valueType ?? 'ABSOLUTE';

    const saveMutation = useMutation({
        mutationFn: () => {
            const rows: Array<{
                currencyCode: string;
                stepQuantity: number;
                value: number;
            }> = [];
            for (const block of blocks) {
                for (const tier of block.tiers) {
                    rows.push({
                        currencyCode: block.currencyCode,
                        stepQuantity: tier.stepQuantity,
                        value: tier.value,
                    });
                }
            }
            return api.mutate(savePriceListVariantPivotMutation, {
                input: { priceListId, productVariantId: variantId, rows },
            } as any);
        },
        onSuccess: () => {
            toast.success(t`Saved`);
            queryClient.invalidateQueries({
                queryKey: ['pricelist-variant-items', priceListId, variantId],
            });
            queryClient.invalidateQueries({
                queryKey: ['pricelist-variant-summaries', priceListId],
            });
        },
        onError: err => {
            console.error('[pricelist] savePriceListVariantPivot failed:', err);
            toast.error(t`Failed to save`);
        },
    });

    // Client-side guard: a block can't have two tiers with the same
    // stepQuantity (the server's UNIQUE constraint would reject it).
    const duplicateTier = useMemo(
        () =>
            blocks.some(b => {
                const steps = b.tiers.map(tr => tr.stepQuantity);
                return new Set(steps).size !== steps.length;
            }),
        [blocks],
    );

    const variant = items[0]?.productVariant;

    if (isLoading || !pl) {
        return <div className="text-sm text-muted-foreground">{t`Loading…`}</div>;
    }

    const headerTitle = variant
        ? `${variant.sku} — ${variant.name}`
        : t`Pricelist item`;

    const usedCurrencies = blocks.map(b => b.currencyCode);

    // === block-level state ops ===
    const updateTier = (
        currency: string,
        index: number,
        patch: Partial<TierRow>,
    ) =>
        setBlocks(prev =>
            prev.map(b =>
                b.currencyCode !== currency
                    ? b
                    : {
                          ...b,
                          tiers: b.tiers.map((tr, i) =>
                              i === index ? { ...tr, ...patch } : tr,
                          ),
                      },
            ),
        );

    const addTier = (currency: string) =>
        setBlocks(prev =>
            prev.map(b => {
                if (b.currencyCode !== currency) return b;
                const nextStep = b.tiers.length
                    ? Math.max(...b.tiers.map(tr => tr.stepQuantity)) + 1
                    : 1;
                return { ...b, tiers: [...b.tiers, { stepQuantity: nextStep, value: 0 }] };
            }),
        );

    const removeTier = (currency: string, index: number) =>
        setBlocks(prev =>
            prev.map(b =>
                b.currencyCode !== currency
                    ? b
                    : { ...b, tiers: b.tiers.filter((_, i) => i !== index) },
            ),
        );

    const removeCurrency = (currency: string) =>
        setBlocks(prev => prev.filter(b => b.currencyCode !== currency));

    const addCurrency = (currency: string) =>
        setBlocks(prev =>
            sortCurrencies(
                [...prev.map(b => b.currencyCode), currency],
                pl.originChannel.defaultCurrencyCode,
            ).map(
                code =>
                    prev.find(b => b.currencyCode === code) ?? {
                        currencyCode: code,
                        tiers: [{ stepQuantity: 1, value: 0 }],
                    },
            ),
        );

    return (
        <Page pageId="pricelist-item-detail">
            <PageTitle>{headerTitle}</PageTitle>

            <PageActionBar>
                <PageActionBarRight>
                    <Button
                        variant="ghost"
                        onClick={() =>
                            navigate({
                                to: '/pricelists/$id',
                                params: { id: priceListId! },
                            })
                        }
                    >
                        {t`Back to pricelist`}
                    </Button>
                    <Button
                        onClick={() => saveMutation.mutate()}
                        disabled={
                            !isEditable || duplicateTier || saveMutation.isPending
                        }
                    >
                        <Save className="h-4 w-4 mr-1" />
                        {t`Save`}
                    </Button>
                </PageActionBarRight>
            </PageActionBar>

            <PageLayout>
                <PageBlock
                    column="main"
                    blockId="pricelist-item-prices"
                    title={
                        <span className="flex items-center gap-3">
                            {t`Prices`}
                            <Badge
                                variant={
                                    valueType === 'PERCENTAGE' ? 'secondary' : 'outline'
                                }
                            >
                                {valueType === 'PERCENTAGE'
                                    ? t`Percentage discounts`
                                    : t`Absolute prices`}
                            </Badge>
                        </span>
                    }
                >
                    <div className="space-y-4">
                        <p className="text-xs text-muted-foreground">
                            {t`One block per currency. Each tier applies from its "Min qty" upwards.`}
                        </p>

                        {blocks.length === 0 && (
                            <p className="text-sm text-muted-foreground">
                                {t`No prices yet. Add a currency to start.`}
                            </p>
                        )}

                        {blocks.map(block => (
                            <CurrencyBlock
                                key={block.currencyCode}
                                block={block}
                                valueType={valueType}
                                isDefault={
                                    block.currencyCode ===
                                    pl.originChannel.defaultCurrencyCode
                                }
                                disabled={!isEditable}
                                onUpdateTier={(i, patch) =>
                                    updateTier(block.currencyCode, i, patch)
                                }
                                onAddTier={() => addTier(block.currencyCode)}
                                onRemoveTier={i => removeTier(block.currencyCode, i)}
                                onRemoveCurrency={() =>
                                    removeCurrency(block.currencyCode)
                                }
                            />
                        ))}

                        <AddCurrencyControl
                            existingCurrencies={usedCurrencies}
                            availableCurrencies={
                                pl.originChannel.availableCurrencyCodes
                            }
                            defaultCurrencyCode={pl.originChannel.defaultCurrencyCode}
                            disabled={!isEditable}
                            onAdd={addCurrency}
                        />

                        {duplicateTier && (
                            <p className="text-xs text-destructive">
                                {t`A currency has two tiers with the same Min qty. Make them distinct before saving.`}
                            </p>
                        )}
                    </div>
                </PageBlock>
            </PageLayout>
        </Page>
    );
}

function sortCurrencies(list: string[], defaultCurrency: string): string[] {
    return [...list].sort((a, b) => {
        if (a === defaultCurrency) return -1;
        if (b === defaultCurrency) return 1;
        return a.localeCompare(b);
    });
}

interface CurrencyBlockProps {
    block: CurrencyBlockData;
    valueType: PriceListValueType;
    isDefault: boolean;
    disabled: boolean;
    onUpdateTier: (index: number, patch: Partial<TierRow>) => void;
    onAddTier: () => void;
    onRemoveTier: (index: number) => void;
    onRemoveCurrency: () => void;
}

/**
 * A bordered section for one currency. Header carries the code + a
 * default badge + the remove-currency action; the body is the tier
 * ladder with always-editable Min-qty and price inputs.
 *
 * A plain bordered `<div>` (not a nested Card) — the parent
 * `PageBlock` is already a Card, and nesting one would double the
 * border.
 */
function CurrencyBlock({
    block,
    valueType,
    isDefault,
    disabled,
    onUpdateTier,
    onAddTier,
    onRemoveTier,
    onRemoveCurrency,
}: Readonly<CurrencyBlockProps>) {
    const { t } = useLingui();
    return (
        <div className="rounded-lg border bg-muted/50 p-4 space-y-3">
            <div className="flex items-center gap-2">
                <span className="font-medium">{block.currencyCode}</span>
                {isDefault && (
                    <Badge variant="success" className="text-[10px]">
                        {t`default`}
                    </Badge>
                )}
                <Button
                    variant="ghost"
                    size="icon-sm"
                    className="ml-auto"
                    disabled={disabled}
                    onClick={onRemoveCurrency}
                    aria-label={t`Remove currency`}
                >
                    <X className="h-4 w-4" />
                </Button>
            </div>

            {block.tiers.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                    {t`No tiers — add one below.`}
                </p>
            ) : (
                <div className="space-y-2">
                    {/* column labels (once) */}
                    <div className="grid grid-cols-[120px_1fr_auto] items-center gap-3 text-xs text-muted-foreground">
                        <span>{t`Min qty`}</span>
                        <span>{t`Price`}</span>
                        <span />
                    </div>
                    {block.tiers.map((tier, i) => (
                        <div
                            // index key is fine — rows are only reordered
                            // by add/remove, and we re-hydrate from server
                            // after save.
                            key={i}
                            className="grid grid-cols-[120px_1fr_auto] items-center gap-3"
                        >
                            <Input
                                type="number"
                                min={1}
                                value={tier.stepQuantity}
                                disabled={disabled}
                                onChange={e =>
                                    onUpdateTier(i, {
                                        stepQuantity: Math.max(
                                            1,
                                            parseInt(e.target.value, 10) || 1,
                                        ),
                                    })
                                }
                            />
                            {valueType === 'PERCENTAGE' ? (
                                <PercentageInput
                                    value={tier.value}
                                    onChange={v => onUpdateTier(i, { value: v })}
                                />
                            ) : (
                                <MoneyInput
                                    name={`price-${block.currencyCode}-${i}`}
                                    value={tier.value}
                                    onChange={(v: number) =>
                                        onUpdateTier(i, { value: v })
                                    }
                                    onBlur={() => {}}
                                    ref={() => {}}
                                    disabled={disabled}
                                    currency={block.currencyCode}
                                />
                            )}
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                disabled={disabled}
                                onClick={() => onRemoveTier(i)}
                                aria-label={t`Remove tier`}
                            >
                                <Trash className="h-4 w-4" />
                            </Button>
                        </div>
                    ))}
                </div>
            )}

            <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={onAddTier}
            >
                <Plus className="h-3 w-3 mr-1" />
                {t`Add tier`}
            </Button>
        </div>
    );
}

interface AddCurrencyControlProps {
    existingCurrencies: string[];
    availableCurrencies: string[];
    defaultCurrencyCode: string;
    disabled: boolean;
    onAdd: (currency: string) => void;
}

function AddCurrencyControl({
    existingCurrencies,
    availableCurrencies,
    defaultCurrencyCode,
    disabled,
    onAdd,
}: Readonly<AddCurrencyControlProps>) {
    const { t } = useLingui();
    const choices = useMemo(
        () => availableCurrencies.filter(c => !existingCurrencies.includes(c)),
        [availableCurrencies, existingCurrencies],
    );
    const [draft, setDraft] = useState<string>(() => choices[0] ?? '');
    useEffect(() => {
        if (!choices.includes(draft)) {
            setDraft(choices[0] ?? '');
        }
    }, [choices, draft]);

    if (choices.length === 0) {
        return (
            <p className="text-xs text-muted-foreground">
                {t`All channel currencies already have a block.`}
            </p>
        );
    }
    return (
        <div className="flex items-center gap-2">
            <Label className="text-sm text-muted-foreground">
                {t`Add currency`}
            </Label>
            <Select
                value={draft}
                onValueChange={(v: string | null) => v && setDraft(v)}
                disabled={disabled}
            >
                <SelectTrigger size="sm" className="w-[200px]">
                    <SelectValue>
                        {(value: unknown) =>
                            typeof value === 'string' && value
                                ? value === defaultCurrencyCode
                                    ? `${value} (${t`default`})`
                                    : value
                                : null
                        }
                    </SelectValue>
                </SelectTrigger>
                <SelectContent>
                    {choices.map(c => (
                        <SelectItem key={c} value={c}>
                            {c === defaultCurrencyCode
                                ? `${c} (${t`default`})`
                                : c}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <Button
                variant="outline"
                size="sm"
                disabled={disabled || !draft}
                onClick={() => draft && onAdd(draft)}
            >
                <Plus className="h-3 w-3 mr-1" />
                {t`Add`}
            </Button>
        </div>
    );
}

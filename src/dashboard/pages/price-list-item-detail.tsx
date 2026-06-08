import { Badge } from '@/vdb/components/ui/badge.js';
import { Button } from '@/vdb/components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/vdb/components/ui/card.js';
import { Input } from '@/vdb/components/ui/input.js';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/vdb/components/ui/select.js';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/vdb/components/ui/table.js';
import { Money } from '@/vdb/components/data-display/money.js';
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
import { Plus, Save, X } from 'lucide-react';
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
import { useIsEditable } from '../lib/use-is-editable';

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

/**
 * Pivot editor for one (priceList, variant) pair.
 *
 * Layout: rows = currencies (default first, then alphabetical),
 * columns = stepQuantity tiers (ascending). Cells are number inputs
 * (or PercentageInput for PERCENTAGE lists). Empty cells mean "no
 * price defined" — they save as DELETE in the diff if previously
 * present, NOOP otherwise.
 *
 * Save sends the full pivot state in one mutation
 * (`savePriceListVariantPivot`) which diffs insert/update/delete on
 * the server — see the matching service method.
 *
 * Composed from Vendure's existing UI primitives (Table, Card, Input,
 * Select, Button) so the page reads as native Vendure dashboard.
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

    // Load the parent pricelist to get valueType and the channel's
    // available currencies. Kept separate from the items query because
    // (a) it's the same query the parent page uses (caches together),
    // and (b) the items query already returns variant info; combining
    // them yields no real saving.
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

    // Pivot draft state. Sorted: currencies with default first then
    // alphabetical, tiers ascending. Cells store value as integer
    // (minor units for ABSOLUTE, basis points for PERCENTAGE).
    const [currencies, setCurrencies] = useState<string[]>([]);
    const [tiers, setTiers] = useState<number[]>([]);
    const [cells, setCells] = useState<Map<string, number>>(new Map());

    const cellKey = (currency: string, step: number) => `${currency}::${step}`;

    // Hydrate draft from server. Deliberately drops local edits when
    // the query refetches — Save-then-invalidate is the canonical
    // way to land changes; no auto-merge with stale draft.
    useEffect(() => {
        if (!pl || !itemsData) return;
        const cs = new Set<string>();
        const ts = new Set<number>();
        const c = new Map<string, number>();
        items.forEach(it => {
            cs.add(it.currencyCode);
            ts.add(it.stepQuantity);
            c.set(cellKey(it.currencyCode, it.stepQuantity), it.value);
        });
        setCurrencies(sortCurrencies(Array.from(cs), pl.originChannel.defaultCurrencyCode));
        setTiers(Array.from(ts).sort((a, b) => a - b));
        setCells(c);
    }, [pl?.id, itemsData]);

    const saveMutation = useMutation({
        mutationFn: () => {
            const rows: Array<{
                currencyCode: string;
                stepQuantity: number;
                value: number;
            }> = [];
            currencies.forEach(currency => {
                tiers.forEach(step => {
                    const v = cells.get(cellKey(currency, step));
                    // Skip empty cells — a missing key means "no price
                    // for this (currency, tier)" and we don't want to
                    // send a default 0 that would clobber intent.
                    if (typeof v === 'number') {
                        rows.push({ currencyCode: currency, stepQuantity: step, value: v });
                    }
                });
            });
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

    const variant = items[0]?.productVariant;
    const valueType: PriceListValueType = pl?.valueType ?? 'ABSOLUTE';

    if (isLoading || !pl) {
        return <div className="text-sm text-muted-foreground">{t`Loading…`}</div>;
    }

    const headerTitle = variant
        ? `${variant.sku} — ${variant.name}`
        : t`Pricelist item`;

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
                        disabled={!isEditable || saveMutation.isPending}
                    >
                        <Save className="h-4 w-4 mr-1" />
                        {t`Save`}
                    </Button>
                </PageActionBarRight>
            </PageActionBar>

            <PageLayout>
                <PageBlock column="main" blockId="pricelist-item-pivot">
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-3">
                                {t`Price pivot`}
                                <Badge
                                    variant={
                                        valueType === 'PERCENTAGE'
                                            ? 'secondary'
                                            : 'outline'
                                    }
                                >
                                    {valueType === 'PERCENTAGE'
                                        ? t`Percentage discounts`
                                        : t`Absolute prices`}
                                </Badge>
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <p className="text-xs text-muted-foreground">
                                {t`Rows are currencies, columns are quantity tiers. Empty cells mean no price is defined for that combination.`}
                            </p>
                            <PivotTable
                                currencies={currencies}
                                tiers={tiers}
                                cells={cells}
                                valueType={valueType}
                                defaultCurrencyCode={pl.originChannel.defaultCurrencyCode}
                                disabled={!isEditable}
                                onChangeCell={(currency, step, value) => {
                                    setCells(prev => {
                                        const next = new Map(prev);
                                        if (value === null) {
                                            next.delete(cellKey(currency, step));
                                        } else {
                                            next.set(cellKey(currency, step), value);
                                        }
                                        return next;
                                    });
                                }}
                                onRemoveCurrency={currency => {
                                    setCurrencies(prev => prev.filter(c => c !== currency));
                                    setCells(prev => {
                                        const next = new Map(prev);
                                        tiers.forEach(step =>
                                            next.delete(cellKey(currency, step)),
                                        );
                                        return next;
                                    });
                                }}
                                onRemoveTier={step => {
                                    setTiers(prev => prev.filter(s => s !== step));
                                    setCells(prev => {
                                        const next = new Map(prev);
                                        currencies.forEach(currency =>
                                            next.delete(cellKey(currency, step)),
                                        );
                                        return next;
                                    });
                                }}
                            />

                            <div className="flex flex-wrap items-center gap-3 pt-1">
                                <AddTierControl
                                    existingTiers={tiers}
                                    disabled={!isEditable}
                                    onAdd={step =>
                                        setTiers(prev =>
                                            Array.from(new Set([...prev, step])).sort(
                                                (a, b) => a - b,
                                            ),
                                        )
                                    }
                                />
                                <AddCurrencyControl
                                    existingCurrencies={currencies}
                                    availableCurrencies={
                                        pl.originChannel.availableCurrencyCodes
                                    }
                                    defaultCurrencyCode={
                                        pl.originChannel.defaultCurrencyCode
                                    }
                                    disabled={!isEditable}
                                    onAdd={currency =>
                                        setCurrencies(prev =>
                                            sortCurrencies(
                                                Array.from(new Set([...prev, currency])),
                                                pl.originChannel.defaultCurrencyCode,
                                            ),
                                        )
                                    }
                                />
                            </div>
                        </CardContent>
                    </Card>
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

interface PivotTableProps {
    currencies: string[];
    tiers: number[];
    cells: Map<string, number>;
    valueType: PriceListValueType;
    defaultCurrencyCode: string;
    disabled: boolean;
    onChangeCell: (currency: string, step: number, value: number | null) => void;
    onRemoveCurrency: (currency: string) => void;
    onRemoveTier: (step: number) => void;
}

function PivotTable({
    currencies,
    tiers,
    cells,
    valueType,
    defaultCurrencyCode,
    disabled,
    onChangeCell,
    onRemoveCurrency,
    onRemoveTier,
}: Readonly<PivotTableProps>) {
    const { t } = useLingui();
    const cellKey = (currency: string, step: number) => `${currency}::${step}`;

    if (currencies.length === 0 || tiers.length === 0) {
        return (
            <p className="text-sm text-muted-foreground">
                {t`Add at least one currency and one tier to start editing prices.`}
            </p>
        );
    }

    return (
        <Table>
            <TableHeader>
                <TableRow>
                    <TableHead className="w-[120px]">{t`Currency`}</TableHead>
                    {tiers.map(step => (
                        <TableHead key={step}>
                            <div className="flex items-center gap-1">
                                <span>{t`qty ${step}+`}</span>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    disabled={disabled}
                                    onClick={() => onRemoveTier(step)}
                                    aria-label={t`Remove tier`}
                                >
                                    <X className="h-3 w-3" />
                                </Button>
                            </div>
                        </TableHead>
                    ))}
                </TableRow>
            </TableHeader>
            <TableBody>
                {currencies.map(currency => (
                    <TableRow key={currency}>
                        <TableCell className="font-medium">
                            <div className="flex items-center gap-1">
                                <span>{currency}</span>
                                {currency === defaultCurrencyCode && (
                                    <Badge variant="success" className="text-[10px]">
                                        {t`default`}
                                    </Badge>
                                )}
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    disabled={disabled}
                                    onClick={() => onRemoveCurrency(currency)}
                                    aria-label={t`Remove currency`}
                                >
                                    <X className="h-3 w-3" />
                                </Button>
                            </div>
                        </TableCell>
                        {tiers.map(step => {
                            const v = cells.get(cellKey(currency, step));
                            return (
                                <TableCell key={step}>
                                    <PivotCell
                                        value={v}
                                        valueType={valueType}
                                        currencyCode={currency}
                                        disabled={disabled}
                                        onChange={next => onChangeCell(currency, step, next)}
                                    />
                                </TableCell>
                            );
                        })}
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
}

interface PivotCellProps {
    value: number | undefined;
    valueType: PriceListValueType;
    currencyCode: string;
    disabled: boolean;
    onChange: (value: number | null) => void;
}

function PivotCell({
    value,
    valueType,
    currencyCode,
    disabled,
    onChange,
}: Readonly<PivotCellProps>) {
    const { t } = useLingui();
    // Treat undefined as "empty" — the merchandiser hasn't defined a
    // price here. A click on the cell turns it into the appropriate
    // editor; X clears it back to empty (which the server will treat
    // as DELETE if previously present).
    const [editing, setEditing] = useState(false);

    if (value === undefined) {
        return editing ? (
            <Editor
                initial={0}
                valueType={valueType}
                currencyCode={currencyCode}
                onCommit={v => {
                    onChange(v);
                    setEditing(false);
                }}
                onCancel={() => setEditing(false)}
                disabled={disabled}
            />
        ) : (
            <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => setEditing(true)}
                className="text-muted-foreground"
            >
                {t`—`}
            </Button>
        );
    }

    return editing ? (
        <Editor
            initial={value}
            valueType={valueType}
            currencyCode={currencyCode}
            onCommit={v => {
                onChange(v);
                setEditing(false);
            }}
            onCancel={() => setEditing(false)}
            disabled={disabled}
        />
    ) : (
        <div className="flex items-center gap-1">
            <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => setEditing(true)}
                className="flex-1 justify-start"
            >
                {valueType === 'PERCENTAGE' ? (
                    <span>{(value / 100).toFixed(2)} %</span>
                ) : (
                    <Money value={value} currency={currencyCode} />
                )}
            </Button>
            <Button
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                onClick={() => onChange(null)}
                aria-label={t`Clear cell`}
            >
                <X className="h-3 w-3" />
            </Button>
        </div>
    );
}

interface EditorProps {
    initial: number;
    valueType: PriceListValueType;
    currencyCode: string;
    disabled: boolean;
    onCommit: (value: number) => void;
    onCancel: () => void;
}

function Editor({
    initial,
    valueType,
    currencyCode,
    disabled,
    onCommit,
    onCancel,
}: Readonly<EditorProps>) {
    const [draft, setDraft] = useState(initial);
    if (valueType === 'PERCENTAGE') {
        return (
            <div className="flex items-center gap-1">
                <PercentageInput value={draft} onChange={setDraft} />
                <Button
                    size="icon-sm"
                    disabled={disabled}
                    onClick={() => onCommit(draft)}
                    aria-label="Save"
                >
                    <Save className="h-3 w-3" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={disabled}
                    onClick={onCancel}
                    aria-label="Cancel"
                >
                    <X className="h-3 w-3" />
                </Button>
            </div>
        );
    }
    return (
        <div className="flex items-center gap-1">
            {/*
              MoneyInput is the same component the catalog variant
              edit page uses — currency affix, major-units display
              (e.g. "19.99 $"), minor-units value handed back to us.
              `name`/`onBlur`/`ref` are stubs since we're not inside
              a react-hook-form Controller here.
            */}
            <MoneyInput
                name="price"
                value={draft}
                onChange={setDraft}
                onBlur={() => {}}
                ref={() => {}}
                disabled={disabled}
                currency={currencyCode}
            />
            <Button
                size="icon-sm"
                disabled={disabled}
                onClick={() => onCommit(draft)}
                aria-label="Save"
            >
                <Save className="h-3 w-3" />
            </Button>
            <Button
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                onClick={onCancel}
                aria-label="Cancel"
            >
                <X className="h-3 w-3" />
            </Button>
        </div>
    );
}

interface AddTierControlProps {
    existingTiers: number[];
    disabled: boolean;
    onAdd: (step: number) => void;
}

function AddTierControl({
    existingTiers,
    disabled,
    onAdd,
}: Readonly<AddTierControlProps>) {
    const { t } = useLingui();
    const [draft, setDraft] = useState<number>(() =>
        existingTiers.length === 0 ? 1 : Math.max(...existingTiers) + 1,
    );
    const isDuplicate = existingTiers.includes(draft);
    return (
        <div className="flex items-center gap-1">
            <Input
                type="number"
                min={1}
                value={draft}
                onChange={e =>
                    setDraft(Math.max(1, parseInt(e.target.value, 10) || 1))
                }
                disabled={disabled}
                className="w-24"
                aria-label={t`Step quantity`}
            />
            <Button
                variant="outline"
                size="sm"
                disabled={disabled || isDuplicate}
                onClick={() => onAdd(draft)}
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
                {t`All channel currencies already in pivot.`}
            </p>
        );
    }
    return (
        <div className="flex items-center gap-1">
            <Select
                value={draft}
                onValueChange={(v: string | null) => v && setDraft(v)}
                disabled={disabled}
            >
                <SelectTrigger>
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {choices.map(c => (
                        <SelectItem key={c} value={c}>
                            {c}
                            {c === defaultCurrencyCode && (
                                <span className="ml-1 text-muted-foreground">
                                    ({t`default`})
                                </span>
                            )}
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
                {t`Add currency`}
            </Button>
        </div>
    );
}

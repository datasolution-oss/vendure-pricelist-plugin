import { Button } from '@/vdb/components/ui/button.js';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/vdb/components/ui/dialog.js';
import { Input } from '@/vdb/components/ui/input.js';
import { Label } from '@/vdb/components/ui/label.js';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/vdb/components/ui/select.js';
import { Money } from '@/vdb/components/data-display/money.js';
import { MoneyInput } from '@/vdb/components/data-input/money-input.js';
import { ProductVariantSelector } from '@/vdb/components/shared/product-variant-selector.js';
import { api } from '@/vdb/graphql/api.js';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { addPriceListItemMutation } from '../gql/mutations';
import { variantCatalogPricesQuery } from '../gql/queries';
import type { PriceListValueType } from '../gql/types';

import { PercentageInput } from './percentage-input';

interface AddPriceListItemDialogProps {
    priceListId: string;
    valueType: PriceListValueType;
    availableCurrencyCodes: string[];
    defaultCurrencyCode: string;
    disabled?: boolean;
}

interface CatalogPriceResult {
    productVariant: {
        id: string;
        sku: string;
        prices: Array<{ currencyCode: string; price: number }>;
    } | null;
}

/**
 * "Add item" affordance for the PriceListItemsGrid.
 *
 * `valueType` is fixed at the list level — the dialog inherits it and
 * picks the matching value input (`PercentageInput` for basis points,
 * plain number input for minor units).
 *
 * Catalog pre-fill (ABSOLUTE lists only): when the merchandiser picks a
 * variant, the dialog fetches `productVariant.prices` and seeds the
 * value field with the price for the selected currency. Re-seeds on
 * currency change. The value stays editable — the merchandiser is
 * usually tweaking *relative to* catalog (a +/− %), so typing from
 * zero would be busywork. PERCENTAGE lists leave value at 0 (a
 * meaningful starting point — 0% discount is the no-op).
 */
export function AddPriceListItemDialog({
    priceListId,
    valueType,
    availableCurrencyCodes,
    defaultCurrencyCode,
    disabled,
}: Readonly<AddPriceListItemDialogProps>) {
    const { t } = useLingui();
    const queryClient = useQueryClient();

    const initialCurrency =
        availableCurrencyCodes.includes(defaultCurrencyCode)
            ? defaultCurrencyCode
            : availableCurrencyCodes[0] ?? defaultCurrencyCode ?? 'EUR';

    const [open, setOpen] = useState(false);
    const [variantId, setVariantId] = useState<string>('');
    const [variantLabel, setVariantLabel] = useState<string>('');
    const [currencyCode, setCurrencyCode] = useState<string>(initialCurrency);
    const [value, setValue] = useState<number>(0);
    const [stepQuantity, setStepQuantity] = useState<number>(1);

    // Fetch the variant's catalog prices once it's picked. Driven by
    // react-query so we get caching + refetch-on-mount semantics for
    // free if the merchandiser opens the dialog repeatedly.
    const { data: catalogData } = useQuery({
        queryKey: ['variant-catalog-prices', variantId],
        queryFn: () =>
            api.query(variantCatalogPricesQuery, {
                id: variantId,
            }) as Promise<CatalogPriceResult>,
        enabled: !!variantId,
    });

    const catalogPriceForCurrency =
        catalogData?.productVariant?.prices.find(
            p => p.currencyCode === currencyCode,
        )?.price ?? null;

    // Auto-fill on variant/currency change for ABSOLUTE lists. Runs
    // every time catalog price changes — including when the user
    // switches currency mid-form — because the catalog price is the
    // sensible default to tweak from. PERCENTAGE lists keep 0%.
    useEffect(() => {
        if (valueType === 'ABSOLUTE' && catalogPriceForCurrency !== null) {
            setValue(catalogPriceForCurrency);
        }
    }, [catalogPriceForCurrency, valueType]);

    const reset = () => {
        setVariantId('');
        setVariantLabel('');
        setCurrencyCode(initialCurrency);
        setValue(0);
        setStepQuantity(1);
    };

    const mutation = useMutation({
        mutationFn: () =>
            api.mutate(addPriceListItemMutation, {
                input: {
                    priceListId,
                    productVariantId: variantId,
                    currencyCode,
                    value,
                    stepQuantity,
                },
            } as any),
        onSuccess: () => {
            toast.success(t`Item added`);
            // PaginatedListDataTable generates its own query key based
            // on the document name — we don't know it precisely here,
            // so invalidate by substring match on any cached query that
            // touches the variant summaries.
            queryClient.invalidateQueries({
                predicate: q =>
                    Array.isArray(q.queryKey) &&
                    q.queryKey.some(
                        seg =>
                            typeof seg === 'string' &&
                            seg.includes('priceListVariantSummaries'),
                    ),
            });
            reset();
            setOpen(false);
        },
        onError: err => {
            console.error('[pricelist] addPriceListItem failed:', err);
            toast.error(t`Failed to add item`);
        },
    });

    const canSubmit = !!variantId && value >= 0 && stepQuantity >= 1;

    return (
        <Dialog
            open={open}
            onOpenChange={next => {
                setOpen(next);
                if (!next) reset();
            }}
        >
            <DialogTrigger render={
                <Button variant="outline" size="sm" disabled={disabled}>
                    <Plus className="h-4 w-4 mr-1" />
                    {t`Add item`}
                </Button>
            } />
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t`Add pricelist item`}</DialogTitle>
                    <DialogDescription>
                        {t`The combination of variant + currency + stepQuantity must be unique within the pricelist.`}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    <div className="space-y-1.5">
                        <Label>{t`Product variant`}</Label>
                        {variantId ? (
                            <div className="flex items-center justify-between rounded-md border bg-muted/40 px-2 py-1.5 text-sm">
                                <span className="font-mono">{variantLabel}</span>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => {
                                        setVariantId('');
                                        setVariantLabel('');
                                    }}
                                    aria-label={t`Clear`}
                                >
                                    <X className="h-3 w-3" />
                                </Button>
                            </div>
                        ) : (
                            <ProductVariantSelector
                                onProductVariantSelect={v => {
                                    setVariantId(v.productVariantId);
                                    setVariantLabel(`${v.sku} — ${v.productVariantName}`);
                                }}
                            />
                        )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <Label>{t`Currency`}</Label>
                            <Select
                                value={currencyCode}
                                onValueChange={(v: string | null) =>
                                    v && setCurrencyCode(v)
                                }
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {availableCurrencyCodes.map(c => (
                                        <SelectItem key={c} value={c}>
                                            {c}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-1.5">
                            <Label>{t`Step quantity`}</Label>
                            <Input
                                type="number"
                                min={1}
                                value={stepQuantity}
                                onChange={e =>
                                    setStepQuantity(
                                        Math.max(1, parseInt(e.target.value, 10) || 1),
                                    )
                                }
                            />
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <Label>
                            {valueType === 'PERCENTAGE'
                                ? t`Discount (%)`
                                : t`Price`}
                        </Label>
                        {valueType === 'PERCENTAGE' ? (
                            <PercentageInput value={value} onChange={setValue} />
                        ) : (
                            // Same `MoneyInput` Vendure ships on the
                            // catalog variant edit page — currency
                            // affix, major-units display, minor-units
                            // value. Stub props (`name`, `onBlur`,
                            // `ref`) are required by the underlying
                            // react-hook-form ControllerRenderProps
                            // shape but unused outside a Form.
                            <MoneyInput
                                name="price"
                                value={value}
                                onChange={setValue}
                                onBlur={() => {}}
                                ref={() => {}}
                                currency={currencyCode}
                            />
                        )}
                        {valueType === 'ABSOLUTE' && variantId && (
                            <CatalogHint
                                price={catalogPriceForCurrency}
                                currencyCode={currencyCode}
                            />
                        )}
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={() => setOpen(false)}>
                        {t`Cancel`}
                    </Button>
                    <Button
                        onClick={() => mutation.mutate()}
                        disabled={!canSubmit || mutation.isPending}
                    >
                        {t`Add`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

interface CatalogHintProps {
    price: number | null;
    currencyCode: string;
}

/**
 * Small "Catalog price: $X.XX" hint shown under the value input.
 *
 * Tells the merchandiser where the auto-filled number came from. If
 * the variant has no catalog price for the selected currency, we say
 * so explicitly — silently leaving the field at 0 would be confusing.
 */
function CatalogHint({ price, currencyCode }: Readonly<CatalogHintProps>) {
    const { t } = useLingui();
    if (price === null) {
        return (
            <p className="text-xs text-muted-foreground">
                {t`No catalog price for ${currencyCode} on this variant.`}
            </p>
        );
    }
    return (
        <p className="text-xs text-muted-foreground">
            {t`Catalog price:`}{' '}
            <Money value={price} currency={currencyCode} />
        </p>
    );
}

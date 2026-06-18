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
import { MoneyInput } from '@/vdb/components/data-input/money-input.js';
import { api } from '@/vdb/graphql/api.js';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { addPriceListItemMutation } from '../gql/mutations';
import { priceListsForVariantQuery, priceListsListQuery } from '../gql/queries';

const ASSOCIATED_QUERY_KEY = 'pricelist-associated-for-add';
const OPTIONS_QUERY_KEY = 'pricelist-options-for-add';

import { PercentageInput } from './percentage-input';

interface PriceListOption {
    id: string;
    code: string;
    name: string;
    valueType: 'ABSOLUTE' | 'PERCENTAGE';
}

interface AddVariantToPriceListDialogProps {
    productVariantId: string;
    variantName: string;
    availableCurrencyCodes: string[];
    defaultCurrencyCode: string;
    /** Called after a successful add so the parent can refresh its table. */
    onAdded?: () => void;
}

/**
 * "Add this variant to a pricelist" affordance for the variant page.
 *
 * The inverse of `AddPriceListItemDialog` (which lives on the pricelist
 * page and picks a variant): here the *variant* is fixed and the
 * merchandiser picks the target *pricelist*. The value input follows the
 * selected list's `valueType` (money for ABSOLUTE, basis points for
 * PERCENTAGE). Backed by the same `addPriceListItem` mutation — the
 * combination of (variant + currency + stepQuantity) must be unique
 * within the list, enforced server-side.
 */
export function AddVariantToPriceListDialog({
    productVariantId,
    variantName,
    availableCurrencyCodes,
    defaultCurrencyCode,
    onAdded,
}: Readonly<AddVariantToPriceListDialogProps>) {
    const { t } = useLingui();
    const queryClient = useQueryClient();

    const initialCurrency = availableCurrencyCodes.includes(defaultCurrencyCode)
        ? defaultCurrencyCode
        : availableCurrencyCodes[0] ?? defaultCurrencyCode ?? 'EUR';

    const [open, setOpen] = useState(false);
    const [priceListId, setPriceListId] = useState<string>('');
    const [currencyCode, setCurrencyCode] = useState<string>(initialCurrency);
    const [value, setValue] = useState<number>(0);
    const [stepQuantity, setStepQuantity] = useState<number>(1);

    // All pricelists on the active channel.
    const { data: listData } = useQuery({
        queryKey: [OPTIONS_QUERY_KEY],
        queryFn: () =>
            api.query(priceListsListQuery, {
                options: { take: 100, sort: { name: 'ASC' } },
            } as any) as Promise<{ priceLists: { items: PriceListOption[] } }>,
        enabled: open,
    });

    // Lists that ALREADY contain this variant — excluded from the picker.
    // Adding here means "put this variant into a list it isn't in yet";
    // tweaking an existing tier is done from the pricelist's own page.
    const { data: assocData } = useQuery({
        queryKey: [ASSOCIATED_QUERY_KEY, productVariantId],
        queryFn: () =>
            api.query(priceListsForVariantQuery, {
                productVariantId,
                options: { take: 200 },
            } as any) as Promise<{ priceListsForVariant: { items: Array<{ id: string }> } }>,
        enabled: open,
    });
    const associatedIds = new Set(
        (assocData?.priceListsForVariant.items ?? []).map(i => i.id),
    );

    const lists = (listData?.priceLists.items ?? []).filter(l => !associatedIds.has(l.id));
    const selected = lists.find(l => l.id === priceListId) ?? null;
    const valueType = selected?.valueType ?? 'ABSOLUTE';

    const reset = () => {
        setPriceListId('');
        setCurrencyCode(initialCurrency);
        setValue(0);
        setStepQuantity(1);
    };

    const mutation = useMutation({
        mutationFn: () =>
            api.mutate(addPriceListItemMutation, {
                input: {
                    priceListId,
                    productVariantId,
                    currencyCode,
                    value,
                    stepQuantity,
                },
            } as any),
        onSuccess: () => {
            toast.success(t`Variant added to pricelist`);
            // Refresh the exclusion set so the just-added list drops out of
            // the picker on the next open.
            queryClient.invalidateQueries({ queryKey: [ASSOCIATED_QUERY_KEY, productVariantId] });
            onAdded?.();
            reset();
            setOpen(false);
        },
        onError: err => {
            console.error('[pricelist] addPriceListItem (from variant) failed:', err);
            toast.error(t`Failed to add variant to pricelist`);
        },
    });

    const canSubmit = !!priceListId && value >= 0 && stepQuantity >= 1;

    return (
        <Dialog
            open={open}
            onOpenChange={next => {
                setOpen(next);
                if (!next) reset();
            }}
        >
            <DialogTrigger
                render={
                    <Button variant="outline" size="sm">
                        <Plus className="h-4 w-4 mr-1" />
                        {t`Add to a pricelist`}
                    </Button>
                }
            />
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t`Add to a pricelist`}</DialogTitle>
                    <DialogDescription>
                        {t`Add a price for this variant to the selected pricelist.`}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    <div className="space-y-1.5">
                        <Label>{t`Variant`}</Label>
                        <div className="rounded-md border bg-muted/40 px-2 py-1.5 text-sm">
                            {variantName}
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <Label>{t`Pricelist`}</Label>
                        <Select
                            value={priceListId}
                            onValueChange={(v: string | null) => v && setPriceListId(v)}
                            disabled={lists.length === 0}
                        >
                            <SelectTrigger>
                                {/* base-ui renders the raw value (the id) by
                                    default — map it back to the list label. */}
                                <SelectValue placeholder={t`Select a pricelist`}>
                                    {(value: string) => {
                                        const l = lists.find(x => x.id === value);
                                        return l ? `${l.name} (${l.code})` : value;
                                    }}
                                </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                                {lists.map(l => (
                                    <SelectItem key={l.id} value={l.id}>
                                        {l.name} ({l.code})
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {lists.length === 0 && (
                            <p className="text-xs text-muted-foreground">
                                {t`This variant is already in every pricelist on this channel.`}
                            </p>
                        )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <Label>{t`Currency`}</Label>
                            <Select
                                value={currencyCode}
                                onValueChange={(v: string | null) => v && setCurrencyCode(v)}
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
                            <Label>{t`Min qty`}</Label>
                            <Input
                                type="number"
                                min={1}
                                value={stepQuantity}
                                onChange={e =>
                                    setStepQuantity(Math.max(1, parseInt(e.target.value, 10) || 1))
                                }
                            />
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <Label>{valueType === 'PERCENTAGE' ? t`Discount (%)` : t`Price`}</Label>
                        {valueType === 'PERCENTAGE' ? (
                            <PercentageInput value={value} onChange={setValue} />
                        ) : (
                            <MoneyInput
                                name="price"
                                value={value}
                                onChange={setValue}
                                onBlur={() => {}}
                                ref={() => {}}
                                currency={currencyCode}
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

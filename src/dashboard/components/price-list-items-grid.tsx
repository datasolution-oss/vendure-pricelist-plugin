import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/vdb/components/ui/alert-dialog.js';
import { Badge } from '@/vdb/components/ui/badge.js';
import { Button } from '@/vdb/components/ui/button.js';
import {
    HoverCard,
    HoverCardContent,
    HoverCardTrigger,
} from '@/vdb/components/ui/hover-card.js';
import { Money } from '@/vdb/components/data-display/money.js';
import { PaginatedListDataTable } from '@/vdb/components/shared/paginated-list-data-table.js';
import { api } from '@/vdb/graphql/api.js';
import { useLingui } from '@lingui/react/macro';
import { useNavigate } from '@tanstack/react-router';
import { ColumnFiltersState, SortingState } from '@tanstack/react-table';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { savePriceListVariantPivotMutation } from '../gql/mutations';
import { priceListVariantSummariesQuery } from '../gql/queries';
import type { PriceListValueType } from '../gql/types';

import { AddPriceListItemDialog } from './add-price-list-item-dialog';

interface PriceListItemsGridProps {
    priceListId: string;
    valueType: PriceListValueType;
    availableCurrencyCodes: string[];
    defaultCurrencyCode: string;
    disabled: boolean;
}

interface SummaryCell {
    currencyCode: string;
    stepQuantity: number;
    value: number;
}

interface VariantRef {
    id: string;
    sku: string;
    name: string;
}

const HOVER_OPEN_DELAY_MS = 150;

/**
 * Per-variant summary table for a pricelist's items.
 *
 * Layout choices:
 *   - SKU column: plain link to the per-variant pivot editor.
 *   - Currencies / Tiers / Prices set: aggregate badges. Hovering
 *     Currencies opens a small list of the currency codes; hovering
 *     Tiers opens the full currency × tier pivot with values. Both use
 *     Vendure's `HoverCard` primitive (same as the main nav).
 *   - Actions: standard Vendure row-actions column — passed via
 *     `rowActions`, which `PaginatedListDataTable` auto-renders as a
 *     three-dot dropdown labeled `Actions` (iso with every other list
 *     surface in the dashboard). Delete is wired to a separately
 *     controlled `AlertDialog` because the dropdown closes on click —
 *     a self-contained `ConfirmationDialog` (which is its own
 *     trigger) wouldn't survive that.
 */
export function PriceListItemsGrid({
    priceListId,
    valueType,
    availableCurrencyCodes,
    defaultCurrencyCode,
    disabled,
}: Readonly<PriceListItemsGridProps>) {
    const { t } = useLingui();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(25);
    const [sorting, setSorting] = useState<SortingState>([]);
    const [filters, setFilters] = useState<ColumnFiltersState>([]);
    const [deleteCandidate, setDeleteCandidate] = useState<VariantRef | null>(null);

    const deleteMutation = useMutation({
        mutationFn: (variantId: string) =>
            api.mutate(savePriceListVariantPivotMutation, {
                input: { priceListId, productVariantId: variantId, rows: [] },
            } as any),
        onSuccess: () => {
            toast.success(t`Variant removed`);
            queryClient.invalidateQueries({
                predicate: q =>
                    Array.isArray(q.queryKey) &&
                    q.queryKey.some(
                        seg =>
                            typeof seg === 'string' &&
                            seg.includes('priceListVariantSummaries'),
                    ),
            });
        },
        onError: err => {
            console.error('[pricelist] delete variant failed:', err);
            toast.error(t`Failed to remove variant`);
        },
    });

    const openEdit = (variant: VariantRef) => {
        navigate({
            to: '/pricelists/$id/items/$variantId',
            params: { id: priceListId, variantId: variant.id },
        });
    };

    return (
        <div className="space-y-3">
            <PaginatedListDataTable
                listQuery={priceListVariantSummariesQuery as any}
                transformVariables={vars => ({ ...vars, priceListId })}
                defaultVisibility={{
                    productVariant: true,
                    currencyCount: true,
                    tierCount: true,
                    latestUpdatedAt: true,
                }}
                rowActions={[
                    {
                        label: (
                            <span className="flex items-center gap-2">
                                <Pencil className="h-4 w-4" />
                                {t`Edit`}
                            </span>
                        ),
                        onClick: (row: any) => openEdit(row.original.productVariant),
                    },
                    {
                        label: (
                            <span className="flex items-center gap-2 text-destructive">
                                <Trash2 className="h-4 w-4" />
                                {t`Remove from pricelist`}
                            </span>
                        ),
                        onClick: (row: any) => setDeleteCandidate(row.original.productVariant),
                    },
                ]}
                customizeColumns={
                    {
                        productVariant: {
                            header: t`Variant`,
                            cell: ({ row }: any) => {
                                const v = row.original.productVariant;
                                return (
                                    <Button
                                        variant="ghost"
                                        onClick={() => openEdit(v)}
                                    >
                                        <span className="font-mono mr-2">{v.sku}</span>
                                        <span className="text-muted-foreground">{v.name}</span>
                                    </Button>
                                );
                            },
                        },
                        currencyCount: {
                            header: t`Currencies`,
                            // `cells` isn't a column on its own — declare it
                            // here so `PaginatedListDataTable`'s field-selection
                            // optimiser keeps it in the query. Without this,
                            // the table strips `cells` and the hover content
                            // is always empty.
                            meta: { dependencies: ['cells'] },
                            cell: ({ row }: any) => (
                                <BadgeWithHover
                                    label={String(row.original.currencyCount)}
                                    content={
                                        <CurrencyList
                                            cells={row.original.cells ?? []}
                                            defaultCurrencyCode={defaultCurrencyCode}
                                        />
                                    }
                                />
                            ),
                        },
                        tierCount: {
                            header: t`Tiers`,
                            meta: { dependencies: ['cells'] },
                            cell: ({ row }: any) => (
                                <BadgeWithHover
                                    label={String(row.original.tierCount)}
                                    content={
                                        <CellBreakdown
                                            cells={row.original.cells ?? []}
                                            valueType={valueType}
                                        />
                                    }
                                />
                            ),
                        },
                        latestUpdatedAt: {
                            header: t`Last updated`,
                        },
                    } as any
                }
                page={page}
                itemsPerPage={pageSize}
                sorting={sorting}
                columnFilters={filters}
                onPageChange={(_t, p, perPage) => {
                    setPage(p);
                    setPageSize(perPage);
                }}
                onSortChange={(_t, s) => setSorting(s)}
                onFilterChange={(_t, f) => setFilters(f)}
            />

            <div className="flex justify-end">
                <AddPriceListItemDialog
                    priceListId={priceListId}
                    valueType={valueType}
                    availableCurrencyCodes={availableCurrencyCodes}
                    defaultCurrencyCode={defaultCurrencyCode}
                    disabled={disabled}
                />
            </div>

            {/*
              Controlled AlertDialog driven by `deleteCandidate`. We can't
              use the wrapping `ConfirmationDialog` here because its
              trigger is its child — and our actual trigger lives inside
              a dropdown menu that closes on click, leaving no trigger
              element mounted at the moment we'd want the confirmation
              to appear.
            */}
            <AlertDialog
                open={deleteCandidate !== null}
                onOpenChange={open => {
                    if (!open) setDeleteCandidate(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {deleteCandidate
                                ? t`Remove ${deleteCandidate.sku} from this pricelist?`
                                : ''}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {t`Every currency × tier price defined for this variant will be deleted. The pricelist itself stays.`}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{t`Cancel`}</AlertDialogCancel>
                        <AlertDialogAction
                            type="button"
                            onClick={() => {
                                if (deleteCandidate) {
                                    deleteMutation.mutate(deleteCandidate.id);
                                }
                                setDeleteCandidate(null);
                            }}
                        >
                            {t`Remove`}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

interface BadgeWithHoverProps {
    label: string;
    content: React.ReactNode;
}

/**
 * A `<Badge>` that opens a `HoverCard` on hover. Used on the
 * Currencies and Tiers columns so the merchandiser can drill into
 * what those aggregate counts cover without leaving the page.
 */
function BadgeWithHover({ label, content }: Readonly<BadgeWithHoverProps>) {
    return (
        <HoverCard>
            <HoverCardTrigger
                delay={HOVER_OPEN_DELAY_MS}
                render={
                    <Badge variant="outline" className="cursor-default">
                        {label}
                    </Badge>
                }
            />
            <HoverCardContent className="w-auto p-0">{content}</HoverCardContent>
        </HoverCard>
    );
}

interface CurrencyListProps {
    cells: SummaryCell[];
    defaultCurrencyCode: string;
}

/**
 * Simple list of distinct currency codes priced for this variant.
 * Default currency badged so the merchandiser sees it at a glance.
 * Renders nothing-marker if the variant has no cells (shouldn't
 * normally happen for a summary row, but defensive).
 */
function CurrencyList({
    cells,
    defaultCurrencyCode,
}: Readonly<CurrencyListProps>) {
    const { t } = useLingui();
    const codes = Array.from(new Set(cells.map(c => c.currencyCode))).sort();
    if (codes.length === 0) {
        return (
            <p className="px-3 py-2 text-xs text-muted-foreground">
                {t`No currencies yet.`}
            </p>
        );
    }
    return (
        <ul className="p-3 text-xs space-y-1">
            {codes.map(c => (
                <li key={c} className="flex items-center gap-2">
                    <span className="font-medium">{c}</span>
                    {c === defaultCurrencyCode && (
                        <Badge variant="success" className="text-[10px]">
                            {t`default`}
                        </Badge>
                    )}
                </li>
            ))}
        </ul>
    );
}

interface CellBreakdownProps {
    cells: SummaryCell[];
    valueType: PriceListValueType;
}

/**
 * Compact pivot of a variant's prices, suitable for a HoverCard.
 *
 * Builds the cross (currencies × tiers) client-side from the inlined
 * cell array. Missing combinations render as "—". For PERCENTAGE
 * lists, value is interpreted as basis points and rendered as
 * `X.XX %` (matches `PercentageInput` and the pivot editor).
 */
function CellBreakdown({ cells, valueType }: Readonly<CellBreakdownProps>) {
    const { t } = useLingui();
    if (cells.length === 0) {
        return (
            <p className="px-3 py-2 text-xs text-muted-foreground">
                {t`No prices defined yet.`}
            </p>
        );
    }
    const currencySet = new Set<string>();
    const tierSet = new Set<number>();
    const byKey = new Map<string, number>();
    cells.forEach(c => {
        currencySet.add(c.currencyCode);
        tierSet.add(c.stepQuantity);
        byKey.set(`${c.currencyCode}::${c.stepQuantity}`, c.value);
    });
    const currencies = Array.from(currencySet).sort();
    const tiers = Array.from(tierSet).sort((a, b) => a - b);

    return (
        <div className="min-w-[14rem] p-3 text-xs">
            <div
                className="grid gap-x-3 gap-y-1"
                style={{
                    gridTemplateColumns: `auto repeat(${tiers.length}, minmax(0,1fr))`,
                }}
            >
                <div></div>
                {tiers.map(step => (
                    <div key={step} className="text-muted-foreground">
                        {t`qty ${step}+`}
                    </div>
                ))}
                {currencies.map(currency => (
                    <CurrencyRow
                        key={currency}
                        currency={currency}
                        tiers={tiers}
                        byKey={byKey}
                        valueType={valueType}
                    />
                ))}
            </div>
        </div>
    );
}

interface CurrencyRowProps {
    currency: string;
    tiers: number[];
    byKey: Map<string, number>;
    valueType: PriceListValueType;
}

function CurrencyRow({
    currency,
    tiers,
    byKey,
    valueType,
}: Readonly<CurrencyRowProps>) {
    return (
        <>
            <div className="font-medium">{currency}</div>
            {tiers.map(step => {
                const v = byKey.get(`${currency}::${step}`);
                if (v === undefined) {
                    return (
                        <div key={step} className="text-muted-foreground">
                            —
                        </div>
                    );
                }
                if (valueType === 'PERCENTAGE') {
                    return <div key={step}>{(v / 100).toFixed(2)} %</div>;
                }
                return (
                    <div key={step}>
                        <Money value={v} currency={currency} />
                    </div>
                );
            })}
        </>
    );
}

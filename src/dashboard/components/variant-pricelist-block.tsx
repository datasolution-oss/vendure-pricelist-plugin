import { Badge } from '@/vdb/components/ui/badge.js';
import { Button } from '@/vdb/components/ui/button.js';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/vdb/components/ui/card.js';
import { Input } from '@/vdb/components/ui/input.js';
import { Label } from '@/vdb/components/ui/label.js';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/vdb/components/ui/select.js';
import { Separator } from '@/vdb/components/ui/separator.js';
import {
    Command,
    CommandEmpty,
    CommandInput,
    CommandItem,
    CommandList,
} from '@/vdb/components/ui/command.js';
import { Money } from '@/vdb/components/data-display/money.js';
import { PaginatedListDataTable } from '@/vdb/components/shared/paginated-list-data-table.js';
import { api } from '@/vdb/graphql/api.js';
import { useChannel } from '@/vdb/hooks/use-channel.js';
import { useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ColumnFiltersState, SortingState } from '@tanstack/react-table';
import { useDebounce } from '@uidotdev/usehooks';
import { ArrowDown, ArrowUp, Minus, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
    priceListsForVariantQuery,
    simulateVariantPriceQuery,
    simulatorCustomerGroupsQuery,
    simulatorCustomersQuery,
} from '../gql/queries';

import { AddVariantToPriceListDialog } from './add-variant-to-pricelist-dialog';

/**
 * Page-block dropped onto the ProductVariant detail page (main column,
 * after the "Price and tax" block). Two read-only sections:
 *
 *  1. Associated pricelists — a standard Vendure paginated table listing
 *     every list on the active channel that contains this variant. Just
 *     the name (linking to the list config) and its value type — no
 *     prices (those live on the list's own page).
 *  2. Price simulator — "what would this customer / group / anonymous
 *     visitor pay at quantity N?". Runs through the *real* resolution +
 *     calculation strategies server-side, so the number matches the
 *     storefront exactly (cheapest-in-group rule included).
 *
 * No mutations — inspection only.
 */

type SimulationMode = 'ANONYMOUS' | 'CUSTOMER' | 'GROUP';

interface ProvenanceEntry {
    listId: string;
    listCode: string;
    groupCode: string | null;
    valueType: 'ABSOLUTE' | 'PERCENTAGE';
    stepQuantity: number;
    value: number;
}

interface SimulatedVariantPrice {
    standardPrice: number | null;
    standardPriceWithTax: number | null;
    resolvedPrice: number | null;
    resolvedPriceWithTax: number | null;
    currencyCode: string;
    source: string | null;
    provenance: ProvenanceEntry[];
}

export function VariantPriceListBlock({ context }: Readonly<{ context: { entity?: any } }>) {
    const { t } = useLingui();
    const { activeChannel } = useChannel();
    const variantId: string | undefined = context.entity?.id;
    const variantName: string = context.entity?.name ?? '';

    const availableCurrencyCodes: string[] = activeChannel?.availableCurrencyCodes ?? ['USD'];
    const defaultCurrencyCode: string = activeChannel?.defaultCurrencyCode ?? 'USD';

    // ---- associated-lists table state ----
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
    const [filters, setFilters] = useState<ColumnFiltersState>([]);
    // Bumped after an "add to pricelist" to remount the table and refetch
    // (the PaginatedListDataTable owns its react-query cache internally).
    const [refreshKey, setRefreshKey] = useState(0);

    // ---- simulator state ----
    const [mode, setMode] = useState<SimulationMode>('ANONYMOUS');
    const [customer, setCustomer] = useState<{ id: string; label: string } | null>(null);
    const [group, setGroup] = useState<{ id: string; name: string } | null>(null);
    const [currencyCode, setCurrencyCode] = useState<string>(defaultCurrencyCode);
    const [quantity, setQuantity] = useState<number>(1);

    // The simulation only runs once the chosen mode has a valid target.
    const targetReady =
        mode === 'ANONYMOUS' ||
        (mode === 'CUSTOMER' && !!customer) ||
        (mode === 'GROUP' && !!group);

    const customerId = mode === 'CUSTOMER' ? customer?.id : undefined;
    const customerGroupId = mode === 'GROUP' ? group?.id : undefined;

    const { data: simData, isFetching: simLoading } = useQuery({
        queryKey: [
            'simulateVariantPrice',
            variantId,
            currencyCode,
            quantity,
            customerId ?? null,
            customerGroupId ?? null,
        ],
        queryFn: () =>
            // `as any` on the variables follows the established
            // convention in this plugin: gql.tada infers custom
            // input-object variables as `never` in this setup.
            api.query(simulateVariantPriceQuery, {
                input: {
                    productVariantId: variantId as string,
                    currencyCode,
                    quantity,
                    customerId,
                    customerGroupId,
                },
            } as any) as Promise<{ simulateVariantPrice: SimulatedVariantPrice }>,
        enabled: !!variantId && targetReady && quantity >= 1,
    });
    const sim = simData?.simulateVariantPrice;

    const delta = useMemo(() => {
        if (!sim || sim.standardPrice == null || sim.resolvedPrice == null) return null;
        const diff = sim.resolvedPrice - sim.standardPrice;
        const pct = sim.standardPrice !== 0 ? (diff / sim.standardPrice) * 100 : 0;
        return { diff, pct };
    }, [sim]);

    if (!variantId) return null;

    return (
        <div className="space-y-4">
            {/* ---- Associated pricelists ---- */}
            <Card>
                <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1.5">
                            <CardTitle>{t`Associated pricelists`}</CardTitle>
                            <CardDescription>
                                {t`Pricelists on this channel that contain this variant.`}
                            </CardDescription>
                        </div>
                        <AddVariantToPriceListDialog
                            productVariantId={variantId}
                            variantName={variantName}
                            availableCurrencyCodes={availableCurrencyCodes}
                            defaultCurrencyCode={defaultCurrencyCode}
                            onAdded={() => setRefreshKey(k => k + 1)}
                        />
                    </div>
                </CardHeader>
                <CardContent>
                    <PaginatedListDataTable
                        key={refreshKey}
                        listQuery={priceListsForVariantQuery as any}
                        transformVariables={(variables: any) => ({
                            ...variables,
                            productVariantId: variantId,
                        })}
                        page={page}
                        itemsPerPage={pageSize}
                        sorting={sorting}
                        columnFilters={filters}
                        onPageChange={(_, p, perPage) => {
                            setPage(p);
                            setPageSize(perPage);
                        }}
                        onSortChange={(_, s) => setSorting(s)}
                        onFilterChange={(_, f) => setFilters(f)}
                        defaultVisibility={{ id: false }}
                        defaultColumnOrder={['name', 'valueType']}
                        customizeColumns={{
                            name: {
                                header: () => t`Name`,
                                cell: ({ cell, row }: any) => (
                                    <Button
                                        variant="ghost"
                                        className="px-0"
                                        render={
                                            <Link
                                                to={`/pricelists/${row.original.id}`}
                                                search={
                                                    {
                                                        fromVariantId: variantId,
                                                        fromVariantName: variantName,
                                                    } as any
                                                }
                                            />
                                        }
                                    >
                                        {cell.getValue() as string}
                                    </Button>
                                ),
                            },
                            valueType: {
                                header: () => t`Type`,
                                cell: ({ cell }: any) => {
                                    const v = cell.getValue() as string;
                                    return (
                                        <Badge variant="secondary">
                                            {v === 'PERCENTAGE' ? t`Percentage` : t`Absolute`}
                                        </Badge>
                                    );
                                },
                            },
                        }}
                    />
                </CardContent>
            </Card>

            {/* ---- Price simulator ---- */}
            <Card>
                <CardHeader>
                    <CardTitle>{t`Price simulator`}</CardTitle>
                    <CardDescription>
                        {t`Resolve the price for a customer, a group or an anonymous visitor at a given quantity.`}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {/* mode toggle */}
                    <div className="flex gap-2">
                        {(
                            [
                                ['ANONYMOUS', t`Anonymous`],
                                ['CUSTOMER', t`Customer`],
                                ['GROUP', t`Group`],
                            ] as Array<[SimulationMode, string]>
                        ).map(([m, label]) => (
                            <Button
                                key={m}
                                type="button"
                                size="sm"
                                variant={mode === m ? 'default' : 'outline'}
                                onClick={() => setMode(m)}
                            >
                                {label}
                            </Button>
                        ))}
                    </div>

                    {/* Inline search picker (no popover → no page-jump on
                        open). The search stays available even after a pick, so
                        the target can be changed at any time. */}
                    {mode === 'CUSTOMER' && (
                        <CustomerPicker
                            selected={customer}
                            onSelect={setCustomer}
                            onClear={() => setCustomer(null)}
                        />
                    )}
                    {mode === 'GROUP' && (
                        <GroupPicker
                            selected={group}
                            onSelect={setGroup}
                            onClear={() => setGroup(null)}
                        />
                    )}

                    {/* currency + quantity */}
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
                            <Label>{t`Quantity`}</Label>
                            <Input
                                type="number"
                                min={1}
                                value={quantity}
                                onChange={e =>
                                    setQuantity(Math.max(1, parseInt(e.target.value, 10) || 1))
                                }
                            />
                        </div>
                    </div>

                    <Separator />

                    {/* result */}
                    {!targetReady ? (
                        <p className="text-sm text-muted-foreground">
                            {mode === 'CUSTOMER'
                                ? t`Select a customer to simulate.`
                                : t`Select a group to simulate.`}
                        </p>
                    ) : simLoading ? (
                        <p className="text-sm text-muted-foreground">{t`Simulating…`}</p>
                    ) : sim ? (
                        <SimulationResult sim={sim} delta={delta} />
                    ) : null}
                </CardContent>
            </Card>
        </div>
    );
}

function CustomerPicker({
    selected,
    onSelect,
    onClear,
}: Readonly<{
    selected: { id: string; label: string } | null;
    onSelect: (v: { id: string; label: string }) => void;
    onClear: () => void;
}>) {
    const { t } = useLingui();
    const [term, setTerm] = useState('');
    const debounced = useDebounce(term, 300);
    const hasTerm = debounced.trim().length > 0;
    const { data, isFetching } = useQuery({
        queryKey: ['sim-customers', debounced],
        queryFn: () =>
            api.query(simulatorCustomersQuery, {
                options: {
                    take: 10,
                    sort: { lastName: 'ASC' },
                    filter: {
                        firstName: { contains: debounced },
                        lastName: { contains: debounced },
                        emailAddress: { contains: debounced },
                    },
                    filterOperator: 'OR',
                },
            } as any) as Promise<{
                customers: {
                    items: Array<{
                        id: string;
                        firstName: string | null;
                        lastName: string | null;
                        emailAddress: string;
                    }>;
                };
            }>,
        // Empty by default — only search once the merchandiser types.
        enabled: hasTerm,
    });
    const items = hasTerm ? data?.customers.items ?? [] : [];

    return (
        <div className="space-y-2">
            {selected ? (
                <SelectedChip label={selected.label} onClear={onClear} />
            ) : (
                <Command shouldFilter={false} className="rounded-md border">
                    <CommandInput
                        placeholder={t`Search a customer…`}
                        value={term}
                        onValueChange={setTerm}
                    />
                    <CommandList className="max-h-48">
                        <CommandEmpty>
                            {!term.trim()
                                ? t`Type to search a customer.`
                                : isFetching
                                  ? t`Searching…`
                                  : t`No customer found`}
                        </CommandEmpty>
                        {items.map(c => {
                            const label =
                                `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() ||
                                c.emailAddress;
                            return (
                                <CommandItem
                                    key={c.id}
                                    value={c.id}
                                    onSelect={() => onSelect({ id: c.id, label })}
                                    className="flex flex-col items-start"
                                >
                                    <span className="font-medium">{label}</span>
                                    <span className="text-xs text-muted-foreground">
                                        {c.emailAddress}
                                    </span>
                                </CommandItem>
                            );
                        })}
                    </CommandList>
                </Command>
            )}
        </div>
    );
}

function GroupPicker({
    selected,
    onSelect,
    onClear,
}: Readonly<{
    selected: { id: string; name: string } | null;
    onSelect: (v: { id: string; name: string }) => void;
    onClear: () => void;
}>) {
    const { t } = useLingui();
    const [term, setTerm] = useState('');
    const { data } = useQuery({
        queryKey: ['sim-groups'],
        queryFn: () =>
            api.query(simulatorCustomerGroupsQuery, {
                options: { take: 100, sort: { name: 'ASC' } },
            } as any) as Promise<{ customerGroups: { items: Array<{ id: string; name: string }> } }>,
        staleTime: 1000 * 60 * 5,
    });
    const all = data?.customerGroups.items ?? [];
    // Empty by default — only show matches once the merchandiser types.
    const items = term.trim()
        ? all.filter(g => g.name.toLowerCase().includes(term.trim().toLowerCase()))
        : [];

    return (
        <div className="space-y-2">
            {selected ? (
                <SelectedChip label={selected.name} onClear={onClear} />
            ) : (
                <Command shouldFilter={false} className="rounded-md border">
                    <CommandInput
                        placeholder={t`Search a group…`}
                        value={term}
                        onValueChange={setTerm}
                    />
                    <CommandList className="max-h-48">
                        <CommandEmpty>
                            {term.trim() ? t`No group found` : t`Type to search a group.`}
                        </CommandEmpty>
                        {items.map(g => (
                            <CommandItem
                                key={g.id}
                                value={g.id}
                                onSelect={() => onSelect({ id: g.id, name: g.name })}
                            >
                                {g.name}
                            </CommandItem>
                        ))}
                    </CommandList>
                </Command>
            )}
        </div>
    );
}

function SelectedChip({
    label,
    onClear,
}: Readonly<{
    label: string;
    onClear: () => void;
}>) {
    const { t } = useLingui();
    return (
        <div className="flex items-center justify-between rounded-md border bg-muted/40 px-2 py-1.5 text-sm">
            <span>{label}</span>
            <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onClear}
                aria-label={t`Clear`}
            >
                <X className="h-3 w-3" />
            </Button>
        </div>
    );
}

function SimulationResult({
    sim,
    delta,
}: Readonly<{
    sim: SimulatedVariantPrice;
    delta: { diff: number; pct: number } | null;
}>) {
    const { t } = useLingui();
    const hasResolved = sim.resolvedPrice != null;
    const DeltaIcon = delta == null || delta.diff === 0 ? Minus : delta.diff < 0 ? ArrowDown : ArrowUp;
    const deltaColor =
        delta == null || delta.diff === 0
            ? 'text-muted-foreground'
            : delta.diff < 0
              ? 'text-success'
              : 'text-destructive';

    return (
        <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4">
                <PriceCell
                    label={t`Standard price`}
                    net={sim.standardPrice}
                    gross={sim.standardPriceWithTax}
                    currency={sim.currencyCode}
                />
                <PriceCell
                    label={t`Resolved price`}
                    net={sim.resolvedPrice}
                    gross={sim.resolvedPriceWithTax}
                    currency={sim.currencyCode}
                    emphasis
                />
            </div>

            {!hasResolved ? (
                <p className="text-sm text-muted-foreground">
                    {t`No pricelist applies — standard price is used.`}
                </p>
            ) : (
                <>
                    {delta && (
                        <div className={`flex items-center gap-1 text-sm ${deltaColor}`}>
                            <DeltaIcon className="h-4 w-4" />
                            <Money value={Math.abs(delta.diff)} currency={sim.currencyCode} />
                            <span>({delta.pct.toFixed(1)}%)</span>
                        </div>
                    )}
                    <div className="flex items-center gap-2 flex-wrap">
                        {sim.source && <Badge variant="secondary">{sim.source}</Badge>}
                        {sim.provenance.map((p, i) => (
                            <div key={`${p.listId}-${i}`} className="flex items-center gap-1">
                                {i > 0 && <span className="text-muted-foreground">→</span>}
                                <Badge variant="outline" className="font-mono text-xs">
                                    {p.listCode}
                                    {p.groupCode ? ` · ${p.groupCode}` : ''}
                                    {' · '}
                                    {p.valueType === 'PERCENTAGE'
                                        ? `${(p.value / 100).toFixed(2)}%`
                                        : p.value}
                                </Badge>
                            </div>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

function PriceCell({
    label,
    net,
    gross,
    currency,
    emphasis,
}: Readonly<{
    label: string;
    net: number | null;
    gross: number | null;
    currency: string;
    emphasis?: boolean;
}>) {
    const { t } = useLingui();
    return (
        <div className={`rounded-md border p-3 ${emphasis ? 'bg-muted/40' : ''}`}>
            <div className="text-xs text-muted-foreground">{label}</div>
            {net == null ? (
                <div className="text-sm text-muted-foreground mt-1">{t`n/a`}</div>
            ) : (
                <div className="mt-1 space-y-0.5">
                    <div className="text-base font-semibold">
                        <Money value={net} currency={currency} />{' '}
                        <span className="text-xs font-normal text-muted-foreground">{t`net`}</span>
                    </div>
                    {gross != null && (
                        <div className="text-sm">
                            <Money value={gross} currency={currency} />{' '}
                            <span className="text-xs text-muted-foreground">{t`gross`}</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

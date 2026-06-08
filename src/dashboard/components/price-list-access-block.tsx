import { Badge } from '@/vdb/components/ui/badge.js';
import { Button } from '@/vdb/components/ui/button.js';
// Card wrapper intentionally removed — the parent `PageBlock` already
// renders its own Card+CardHeader (driven by `title`/`description`
// props). Wrapping here produced a visible double border.
import { Input } from '@/vdb/components/ui/input.js';
import { Switch } from '@/vdb/components/ui/switch.js';
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from '@/vdb/components/ui/tabs.js';
import { CustomerGroupSelector } from '@/vdb/components/shared/customer-group-selector.js';
import { CustomerSelector } from '@/vdb/components/shared/customer-selector.js';
import { api } from '@/vdb/graphql/api.js';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
    addCustomerGroupsToPriceListMutation,
    addCustomersToPriceListMutation,
    removeCustomerGroupsFromPriceListMutation,
    removeCustomersFromPriceListMutation,
    setPriceListAssignedToEveryoneMutation,
} from '../gql/mutations';
import {
    priceListAssignedCustomerGroupsQuery,
    priceListAssignedCustomersQuery,
} from '../gql/queries';
import type {
    PriceListAssignedCustomerGroupsResult,
    PriceListAssignedCustomersResult,
} from '../gql/types';

interface PriceListAccessBlockProps {
    priceListId: string;
    assignedToEveryone: boolean;
    disabled: boolean;
}

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Customer-access editor: paginated, searchable.
 *
 * Both panes load via dedicated paginated queries
 * (`priceListAssignedCustomers`, `priceListAssignedCustomerGroups`) so the
 * detail page works for lists with thousands of customer assignments —
 * the previous "inline the whole array" path made the page unusable past a
 * few hundred entries.
 *
 * `filter` is a single string the server matches case-insensitively
 * against email/first/last name for customers, and `name` for groups —
 * sized for merchandiser search ergonomics, not a full-text engine.
 */
export function PriceListAccessBlock({
    priceListId,
    assignedToEveryone,
    disabled,
}: Readonly<PriceListAccessBlockProps>) {
    const { t } = useLingui();
    const queryClient = useQueryClient();

    const invalidate = () => {
        // Both the access panes and the detail header (assignedToEveryone)
        // need to refresh. Invalidate the broader bucket too so the lists
        // page re-counts.
        queryClient.invalidateQueries({ queryKey: ['pricelist', priceListId] });
        queryClient.invalidateQueries({
            queryKey: ['pricelist-customers', priceListId],
        });
        queryClient.invalidateQueries({
            queryKey: ['pricelist-customer-groups', priceListId],
        });
    };

    const everyoneMutation = useMutation({
        mutationFn: (assigned: boolean) =>
            api.mutate(setPriceListAssignedToEveryoneMutation, {
                priceListId,
                assigned,
            } as any),
        onSuccess: () => {
            toast.success(t`Updated`);
            invalidate();
        },
        onError: err => {
            console.error('[pricelist] setAssignedToEveryone failed:', err);
            toast.error(t`Failed to update`);
        },
    });

    const addCustomerMutation = useMutation({
        mutationFn: (customerId: string) =>
            api.mutate(addCustomersToPriceListMutation, {
                priceListId,
                customerIds: [customerId],
            } as any),
        onSuccess: () => invalidate(),
        onError: err => {
            console.error('[pricelist] addCustomers failed:', err);
            toast.error(t`Failed to add customer`);
        },
    });

    const removeCustomerMutation = useMutation({
        mutationFn: (customerId: string) =>
            api.mutate(removeCustomersFromPriceListMutation, {
                priceListId,
                customerIds: [customerId],
            } as any),
        onSuccess: () => invalidate(),
        onError: err => {
            console.error('[pricelist] removeCustomers failed:', err);
            toast.error(t`Failed to remove customer`);
        },
    });

    const addGroupMutation = useMutation({
        mutationFn: (customerGroupId: string) =>
            api.mutate(addCustomerGroupsToPriceListMutation, {
                priceListId,
                customerGroupIds: [customerGroupId],
            } as any),
        onSuccess: () => invalidate(),
        onError: err => {
            console.error('[pricelist] addCustomerGroups failed:', err);
            toast.error(t`Failed to add customer group`);
        },
    });

    const removeGroupMutation = useMutation({
        mutationFn: (customerGroupId: string) =>
            api.mutate(removeCustomerGroupsFromPriceListMutation, {
                priceListId,
                customerGroupIds: [customerGroupId],
            } as any),
        onSuccess: () => invalidate(),
        onError: err => {
            console.error('[pricelist] removeCustomerGroups failed:', err);
            toast.error(t`Failed to remove customer group`);
        },
    });

    return (
        <div className="space-y-6 text-sm">
            <div className="flex items-center justify-between">
                    <div>
                        <div className="font-medium">{t`Available to everyone`}</div>
                        <div className="text-muted-foreground">
                            {t`When enabled, this pricelist applies to all customers regardless of the lists below.`}
                        </div>
                    </div>
                    <Switch
                        checked={assignedToEveryone}
                        onCheckedChange={checked => everyoneMutation.mutate(checked)}
                        disabled={disabled || everyoneMutation.isPending}
                    />
                </div>

                <Tabs defaultValue="customers">
                    <TabsList>
                        <TabsTrigger value="customers">
                            {t`Customers`}
                        </TabsTrigger>
                        <TabsTrigger value="groups">
                            {t`Customer groups`}
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="customers" className="pt-3">
                        <CustomersPane
                            priceListId={priceListId}
                            disabled={disabled}
                            onAdd={id => addCustomerMutation.mutate(id)}
                            onRemove={id => removeCustomerMutation.mutate(id)}
                            removeBusy={removeCustomerMutation.isPending}
                        />
                    </TabsContent>

                    <TabsContent value="groups" className="pt-3">
                        <CustomerGroupsPane
                            priceListId={priceListId}
                            disabled={disabled}
                            onAdd={id => addGroupMutation.mutate(id)}
                            onRemove={id => removeGroupMutation.mutate(id)}
                            removeBusy={removeGroupMutation.isPending}
                        />
                    </TabsContent>
            </Tabs>
        </div>
    );
}

function useDebouncedString(value: string, delayMs: number): string {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const handle = setTimeout(() => setDebounced(value), delayMs);
        return () => clearTimeout(handle);
    }, [value, delayMs]);
    return debounced;
}

interface CustomersPaneProps {
    priceListId: string;
    disabled: boolean;
    onAdd: (id: string) => void;
    onRemove: (id: string) => void;
    removeBusy: boolean;
}

function CustomersPane({
    priceListId,
    disabled,
    onAdd,
    onRemove,
    removeBusy,
}: Readonly<CustomersPaneProps>) {
    const { t } = useLingui();
    const [filter, setFilter] = useState('');
    const [page, setPage] = useState(0);
    const debouncedFilter = useDebouncedString(filter, SEARCH_DEBOUNCE_MS);

    // Resetting to page 0 when the filter changes avoids landing on an
    // empty page after the result set shrinks.
    useEffect(() => {
        setPage(0);
    }, [debouncedFilter]);

    const { data, isLoading } = useQuery({
        queryKey: ['pricelist-customers', priceListId, page, debouncedFilter],
        queryFn: () =>
            api.query(priceListAssignedCustomersQuery, {
                priceListId,
                options: {
                    skip: page * PAGE_SIZE,
                    take: PAGE_SIZE,
                    filter: debouncedFilter || undefined,
                },
            } as any) as Promise<PriceListAssignedCustomersResult>,
    });

    const items = data?.priceListAssignedCustomers.items ?? [];
    const totalItems = data?.priceListAssignedCustomers.totalItems ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
                <Input
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    placeholder={t`Search by name or email`}
                    className="max-w-sm"
                />
                <span className="text-xs text-muted-foreground">
                    {t`${totalItems} total`}
                </span>
            </div>

            {isLoading ? (
                <p className="text-muted-foreground">{t`Loading…`}</p>
            ) : items.length === 0 ? (
                <p className="text-muted-foreground">{t`No matching customers.`}</p>
            ) : (
                <ul className="space-y-1">
                    {items.map(c => (
                        <li
                            key={c.id}
                            className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1"
                        >
                            <span>
                                {c.firstName} {c.lastName}{' '}
                                <span className="text-muted-foreground">
                                    ({c.emailAddress})
                                </span>
                            </span>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => onRemove(c.id)}
                                disabled={disabled || removeBusy}
                                aria-label={t`Remove`}
                            >
                                <Trash2 className="h-3 w-3 text-destructive" />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            <div className="flex items-center justify-between gap-2">
                {!disabled && (
                    <CustomerSelector
                        onSelect={c => onAdd(c.id)}
                        label={t`Add customer…`}
                    />
                )}
                <div className="flex items-center gap-2 ml-auto">
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
                        onClick={() =>
                            setPage(p => Math.min(totalPages - 1, p + 1))
                        }
                        disabled={page >= totalPages - 1}
                        aria-label={t`Next page`}
                    >
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            </div>
        </div>
    );
}

interface CustomerGroupsPaneProps {
    priceListId: string;
    disabled: boolean;
    onAdd: (id: string) => void;
    onRemove: (id: string) => void;
    removeBusy: boolean;
}

function CustomerGroupsPane({
    priceListId,
    disabled,
    onAdd,
    onRemove,
    removeBusy,
}: Readonly<CustomerGroupsPaneProps>) {
    const { t } = useLingui();
    const [filter, setFilter] = useState('');
    const [page, setPage] = useState(0);
    const debouncedFilter = useDebouncedString(filter, SEARCH_DEBOUNCE_MS);

    useEffect(() => {
        setPage(0);
    }, [debouncedFilter]);

    const { data, isLoading } = useQuery({
        queryKey: ['pricelist-customer-groups', priceListId, page, debouncedFilter],
        queryFn: () =>
            api.query(priceListAssignedCustomerGroupsQuery, {
                priceListId,
                options: {
                    skip: page * PAGE_SIZE,
                    take: PAGE_SIZE,
                    filter: debouncedFilter || undefined,
                },
            } as any) as Promise<PriceListAssignedCustomerGroupsResult>,
    });

    const items = data?.priceListAssignedCustomerGroups.items ?? [];
    const totalItems = data?.priceListAssignedCustomerGroups.totalItems ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
                <Input
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    placeholder={t`Search by name`}
                    className="max-w-sm"
                />
                <span className="text-xs text-muted-foreground">
                    {t`${totalItems} total`}
                </span>
            </div>

            {isLoading ? (
                <p className="text-muted-foreground">{t`Loading…`}</p>
            ) : items.length === 0 ? (
                <p className="text-muted-foreground">{t`No matching customer groups.`}</p>
            ) : (
                <ul className="space-y-1">
                    {items.map(g => (
                        <li
                            key={g.id}
                            className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1"
                        >
                            <Badge variant="secondary">{g.name}</Badge>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => onRemove(g.id)}
                                disabled={disabled || removeBusy}
                                aria-label={t`Remove`}
                            >
                                <Trash2 className="h-3 w-3 text-destructive" />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            <div className="flex items-center justify-between gap-2">
                {!disabled && (
                    <CustomerGroupSelector onSelect={g => onAdd(g.id)} />
                )}
                <div className="flex items-center gap-2 ml-auto">
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
                        onClick={() =>
                            setPage(p => Math.min(totalPages - 1, p + 1))
                        }
                        disabled={page >= totalPages - 1}
                        aria-label={t`Next page`}
                    >
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            </div>
        </div>
    );
}

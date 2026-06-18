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
import { Money } from '@/vdb/components/data-display/money.js';
import { CustomerSelector } from '@/vdb/components/shared/customer-selector.js';
import { CustomerGroupSelector } from '@/vdb/components/shared/customer-group-selector.js';
import { api } from '@/vdb/graphql/api.js';
import { useChannel } from '@/vdb/hooks/use-channel.js';
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Minus, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { priceListsForVariantQuery, simulateVariantPriceQuery } from '../gql/queries';

/**
 * Page-block dropped onto the ProductVariant detail page (main column,
 * after the "Price and tax" block). Two read-only sections:
 *
 *  1. Associated pricelists — every list on the active channel that
 *     contains this variant, with its group and per-currency / per-tier
 *     cells.
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

interface VariantPriceListAssociation {
    priceList: { id: string; code: string; name: string; valueType: 'ABSOLUTE' | 'PERCENTAGE' };
    group: { id: string; code: string; name: string } | null;
    cells: Array<{ currencyCode: string; stepQuantity: number; value: number }>;
}

export function VariantPriceListBlock({ context }: Readonly<{ context: { entity?: any } }>) {
    const { t } = useLingui();
    const { activeChannel } = useChannel();
    const variantId: string | undefined = context.entity?.id;

    const availableCurrencyCodes: string[] = activeChannel?.availableCurrencyCodes ?? ['USD'];
    const defaultCurrencyCode: string = activeChannel?.defaultCurrencyCode ?? 'USD';

    const [mode, setMode] = useState<SimulationMode>('ANONYMOUS');
    const [customer, setCustomer] = useState<{ id: string; label: string } | null>(null);
    const [group, setGroup] = useState<{ id: string; name: string } | null>(null);
    const [currencyCode, setCurrencyCode] = useState<string>(defaultCurrencyCode);
    const [quantity, setQuantity] = useState<number>(1);

    const { data: associationsData } = useQuery({
        queryKey: ['priceListsForVariant', variantId],
        queryFn: () =>
            api.query(priceListsForVariantQuery, {
                productVariantId: variantId as string,
            }) as Promise<{ priceListsForVariant: VariantPriceListAssociation[] }>,
        enabled: !!variantId,
    });
    const associations = associationsData?.priceListsForVariant ?? [];

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
            // convention in this plugin (cf. addPriceListItemMutation):
            // gql.tada infers custom input-object variables as `never`
            // in this setup, so scalar-only operations type cleanly but
            // input-object ones need the cast.
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
                    <CardTitle>{t`Associated pricelists`}</CardTitle>
                    <CardDescription>
                        {t`Pricelists on this channel that contain this variant.`}
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {associations.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            {t`This variant is not in any pricelist.`}
                        </p>
                    ) : (
                        <div className="space-y-3">
                            {associations.map(a => (
                                <div
                                    key={a.priceList.id}
                                    className="rounded-md border p-3 space-y-2"
                                >
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="font-medium">{a.priceList.name}</span>
                                        <Badge variant="outline" className="font-mono text-xs">
                                            {a.priceList.code}
                                        </Badge>
                                        <Badge variant="secondary">
                                            {a.priceList.valueType === 'PERCENTAGE'
                                                ? t`Percentage`
                                                : t`Absolute`}
                                        </Badge>
                                        {a.group && (
                                            <Badge variant="default">{a.group.name}</Badge>
                                        )}
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        {a.cells.map(c => (
                                            <div
                                                key={`${c.currencyCode}-${c.stepQuantity}`}
                                                className="rounded border bg-muted/40 px-2 py-1 text-xs"
                                            >
                                                <span className="text-muted-foreground">
                                                    {c.currencyCode} · {t`qty`} {c.stepQuantity}
                                                </span>{' '}
                                                <span className="font-medium">
                                                    {a.priceList.valueType === 'PERCENTAGE' ? (
                                                        `${(c.value / 100).toFixed(2)} %`
                                                    ) : (
                                                        <Money
                                                            value={c.value}
                                                            currency={c.currencyCode}
                                                        />
                                                    )}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
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

                    {/* target selector */}
                    {mode === 'CUSTOMER' &&
                        (customer ? (
                            <div className="flex items-center justify-between rounded-md border bg-muted/40 px-2 py-1.5 text-sm">
                                <span>{customer.label}</span>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => setCustomer(null)}
                                    aria-label={t`Clear`}
                                >
                                    <X className="h-3 w-3" />
                                </Button>
                            </div>
                        ) : (
                            <CustomerSelector
                                label={t`Customer`}
                                onSelect={c =>
                                    setCustomer({
                                        id: c.id,
                                        label:
                                            `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() ||
                                            c.emailAddress,
                                    })
                                }
                            />
                        ))}
                    {mode === 'GROUP' &&
                        (group ? (
                            <div className="flex items-center justify-between rounded-md border bg-muted/40 px-2 py-1.5 text-sm">
                                <span>{group.name}</span>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => setGroup(null)}
                                    aria-label={t`Clear`}
                                >
                                    <X className="h-3 w-3" />
                                </Button>
                            </div>
                        ) : (
                            <CustomerGroupSelector onSelect={g => setGroup(g)} />
                        ))}

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
                        <SimulationResult sim={sim} delta={delta} t={t} />
                    ) : null}
                </CardContent>
            </Card>
        </div>
    );
}

function SimulationResult({
    sim,
    delta,
    t,
}: Readonly<{
    sim: SimulatedVariantPrice;
    delta: { diff: number; pct: number } | null;
    t: (s: TemplateStringsArray, ...a: any[]) => string;
}>) {
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
                    t={t}
                />
                <PriceCell
                    label={t`Resolved price`}
                    net={sim.resolvedPrice}
                    gross={sim.resolvedPriceWithTax}
                    currency={sim.currencyCode}
                    emphasis
                    t={t}
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
    t,
}: Readonly<{
    label: string;
    net: number | null;
    gross: number | null;
    currency: string;
    emphasis?: boolean;
    t: (s: TemplateStringsArray, ...a: any[]) => string;
}>) {
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

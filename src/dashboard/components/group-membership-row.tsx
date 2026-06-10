import { Badge } from '@/vdb/components/ui/badge.js';
import { Button } from '@/vdb/components/ui/button.js';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/vdb/components/ui/select.js';
import { TableCell, TableRow } from '@/vdb/components/ui/table.js';
import { ConfirmationDialog } from '@/vdb/components/shared/confirmation-dialog.js';
import { api } from '@/vdb/graphql/api.js';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
    changePriceListGroupMutation,
} from '../gql/mutations';
import { priceListGroupsByChannelQuery } from '../gql/queries';
import type { PriceListGroupsByChannelResult } from '../gql/types';

interface GroupMembershipRowProps {
    priceListId: string;
    membershipId: string;
    channelId: string;
    channelCode: string;
    currentGroupId: string;
    currentGroupCode: string;
    isOrigin: boolean;
    disabled: boolean;
    onChanged: () => void;
    onUnshare: () => void;
}

/**
 * One row of the "Channel memberships" table. The Group cell is an
 * inline Select listing the groups available on that membership's
 * channel — picking another fires `changePriceListGroup`. The group
 * binding can only be edited from the origin channel (server guard
 * `assertEditableList`), so the Select is disabled when `disabled`.
 *
 * Each row lazily fetches its own channel's groups; memberships are
 * few (origin + a handful of shared channels) and react-query dedupes
 * by channelId, so the per-row query is cheap.
 */
export function GroupMembershipRow({
    priceListId,
    membershipId,
    channelId,
    channelCode,
    currentGroupId,
    currentGroupCode,
    isOrigin,
    disabled,
    onChanged,
    onUnshare,
}: Readonly<GroupMembershipRowProps>) {
    const { t } = useLingui();

    const { data: groupsData, isLoading } = useQuery({
        queryKey: ['pricelist-groups-by-channel', channelId],
        enabled: !disabled,
        queryFn: () =>
            api.query(priceListGroupsByChannelQuery, {
                channelId,
            }) as Promise<PriceListGroupsByChannelResult>,
    });

    const groups = groupsData?.priceListGroupsByChannel ?? [];

    const changeMutation = useMutation({
        mutationFn: (groupId: string) =>
            api.mutate(changePriceListGroupMutation, {
                priceListId,
                channelId,
                groupId,
            } as any),
        onSuccess: () => {
            toast.success(t`Group changed`);
            onChanged();
        },
        onError: err => {
            console.error('[pricelist] changePriceListGroup failed:', err);
            toast.error(t`Failed to change group`);
        },
    });

    return (
        <TableRow>
            <TableCell className="font-mono">{channelCode}</TableCell>
            <TableCell>
                {disabled ? (
                    <span className="font-mono">{currentGroupCode}</span>
                ) : (
                    <Select
                        value={currentGroupId}
                        onValueChange={(v: string | null) => {
                            if (v && v !== currentGroupId) {
                                changeMutation.mutate(v);
                            }
                        }}
                        disabled={isLoading || changeMutation.isPending}
                    >
                        <SelectTrigger size="sm" className="w-[220px]">
                            {/*
                              Resolve the label ourselves — base-ui's
                              auto-mirror shows the raw id when the value
                              is set from props (not a manual pick) before
                              items mount. Fall back to the known current
                              code until the channel's groups load.
                            */}
                            <SelectValue>
                                {(value: unknown) => {
                                    const g = groups.find(x => x.id === value);
                                    return g
                                        ? `${g.name} (${g.code})`
                                        : currentGroupCode;
                                }}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {/*
                              Plain-string children — a mixed JSX child
                              makes the Select's value mirror fall back to
                              showing the raw id (same bug fixed in the
                              share dialog).
                            */}
                            {groups.map(g => (
                                <SelectItem key={g.id} value={g.id}>
                                    {g.isDefault
                                        ? `${g.name} (${g.code}) — ${t`default`}`
                                        : `${g.name} (${g.code})`}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )}
            </TableCell>
            <TableCell>
                {isOrigin && <Badge variant="success">{t`origin`}</Badge>}
            </TableCell>
            <TableCell className="text-right">
                {!isOrigin && (
                    <ConfirmationDialog
                        title={t`Stop sharing on this channel?`}
                        description={t`The pricelist will no longer be visible on the target channel. Items remain intact.`}
                        confirmText={t`Stop sharing`}
                        onConfirm={onUnshare}
                    >
                        <Button variant="ghost" size="sm" disabled={disabled}>
                            {t`Stop sharing`}
                        </Button>
                    </ConfirmationDialog>
                )}
            </TableCell>
        </TableRow>
    );
}

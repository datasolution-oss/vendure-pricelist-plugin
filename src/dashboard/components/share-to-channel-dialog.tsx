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
import { Label } from '@/vdb/components/ui/label.js';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/vdb/components/ui/select.js';
import { ChannelSelector } from '@/vdb/components/shared/channel-selector.js';
import { api } from '@/vdb/graphql/api.js';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Share2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { assignPriceListToChannelMutation } from '../gql/mutations';
import { priceListGroupsByChannelQuery } from '../gql/queries';
import type { PriceListGroupsByChannelResult } from '../gql/types';

interface ShareToChannelDialogProps {
    priceListId: string;
    /** Channels the list is already in (excluded from the selector). */
    excludeChannelIds: string[];
    disabled?: boolean;
}

/**
 * Two-step share UX:
 *   1. Pick a target channel (via Vendure's standard ChannelSelector).
 *   2. Pick the destination group on that channel (dropdown populated
 *      from priceListGroupsByChannel — added in the Stage 1B finish batch).
 *
 * Server enforces that the chosen group belongs to the target channel
 * (PRICELIST_GROUP_CHANNEL_MISMATCH error code surfaces as a toast).
 */
export function ShareToChannelDialog({
    priceListId,
    excludeChannelIds,
    disabled,
}: Readonly<ShareToChannelDialogProps>) {
    const { t } = useLingui();
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const [channelId, setChannelId] = useState<string>('');
    const [groupId, setGroupId] = useState<string>('');

    // The standard ChannelSelector can't filter its options, so we
    // validate the choice instead: if the picked channel is one the
    // list already belongs to, block the share with an inline message
    // rather than letting the server reject it with a generic error.
    const alreadyShared =
        channelId.length > 0 && excludeChannelIds.includes(channelId);

    // Fetch the groups for the chosen target channel. Lazily enabled —
    // doesn't fire until a channel is picked.
    const { data: groupsData, isLoading: groupsLoading } = useQuery({
        queryKey: ['pricelist-groups-by-channel', channelId],
        enabled: !!channelId,
        queryFn: () =>
            api.query(priceListGroupsByChannelQuery, {
                channelId,
            }) as Promise<PriceListGroupsByChannelResult>,
    });

    const mutation = useMutation({
        mutationFn: () =>
            api.mutate(assignPriceListToChannelMutation, {
                input: { priceListId, channelId, groupId },
            } as any),
        onSuccess: () => {
            toast.success(t`Shared to channel`);
            queryClient.invalidateQueries({ queryKey: ['pricelist', priceListId] });
            setOpen(false);
            setChannelId('');
            setGroupId('');
        },
        onError: err => {
            console.error('[pricelist] assignPriceListToChannel failed:', err);
            toast.error(t`Failed to share — check the target channel and group.`);
        },
    });

    const groups = groupsData?.priceListGroupsByChannel ?? [];

    // Pre-select the target channel's default group once the groups
    // load (the merchandiser can still pick another). Only auto-fills
    // when nothing is selected yet, so it doesn't fight a manual pick.
    useEffect(() => {
        if (!groupId && groups.length > 0) {
            const def = groups.find(g => g.isDefault) ?? groups[0];
            if (def) setGroupId(def.id);
        }
    }, [groups, groupId]);

    return (
        <Dialog
            open={open}
            onOpenChange={next => {
                setOpen(next);
                if (!next) {
                    setChannelId('');
                    setGroupId('');
                }
            }}
        >
            <DialogTrigger render={
                <Button variant="outline" size="sm" disabled={disabled}>
                    <Share2 className="h-4 w-4 mr-1" />
                    {t`Share to channel`}
                </Button>
            } />
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t`Share to another channel`}</DialogTitle>
                    <DialogDescription>
                        {t`Pick a target channel and the destination group on that channel.`}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    <div className="space-y-1.5">
                        <Label>{t`Target channel`}</Label>
                        <ChannelSelector
                            value={channelId}
                            onChange={(v: string) => {
                                setChannelId(v);
                                setGroupId(''); // reset group when channel changes
                            }}
                            multiple={false}
                        />
                        {alreadyShared && (
                            <p className="text-xs text-destructive">
                                {t`This pricelist is already shared to that channel.`}
                            </p>
                        )}
                    </div>

                    <div className="space-y-1.5">
                        <Label>{t`Destination group`}</Label>
                        <Select
                            value={groupId}
                            onValueChange={(v: string | null) => v && setGroupId(v)}
                            disabled={!channelId || groupsLoading}
                        >
                            <SelectTrigger>
                                {/*
                                  Render the label from our own `groups`
                                  lookup. base-ui's auto-mirror can't
                                  resolve id→label when the value is set
                                  programmatically (G2 pre-selection)
                                  before the items mount — it would show
                                  the raw id until a manual pick.
                                */}
                                <SelectValue
                                    placeholder={
                                        channelId
                                            ? groupsLoading
                                                ? t`Loading…`
                                                : t`Pick a group`
                                            : t`Pick a channel first`
                                    }
                                >
                                    {(value: unknown) => {
                                        const g = groups.find(
                                            x => x.id === value,
                                        );
                                        if (!g) return null;
                                        return g.isDefault
                                            ? `${g.name} (${g.code}) — ${t`default`}`
                                            : `${g.name} (${g.code})`;
                                    }}
                                </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                                {groups.map(g => (
                                    // Child MUST be a single plain string —
                                    // the Select's value-mirror renders the
                                    // chosen item's text into the trigger,
                                    // and a mixed JSX child (the previous
                                    // `{g.name} ({g.code}){cond && ...}` form)
                                    // made it fall back to showing the raw
                                    // `value` (the group id).
                                    <SelectItem key={g.id} value={g.id}>
                                        {g.isDefault
                                            ? `${g.name} (${g.code}) — ${t`default`}`
                                            : `${g.name} (${g.code})`}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {channelId && !groupsLoading && groups.length === 0 && (
                            <p className="text-xs text-muted-foreground">
                                {t`That channel has no groups yet.`}
                            </p>
                        )}
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={() => setOpen(false)}>
                        {t`Cancel`}
                    </Button>
                    <Button
                        onClick={() => mutation.mutate()}
                        disabled={
                            !channelId ||
                            !groupId ||
                            alreadyShared ||
                            mutation.isPending
                        }
                    >
                        {t`Share`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

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
import { api } from '@/vdb/graphql/api.js';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { createPriceListGroupMutation } from '../gql/mutations';

export function CreatePriceListGroupDialog() {
    const { t } = useLingui();
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const [code, setCode] = useState('');
    const [name, setName] = useState('');
    const [priority, setPriority] = useState(0);

    const mutation = useMutation({
        mutationFn: () =>
            api.mutate(createPriceListGroupMutation, {
                input: {
                    code,
                    priority,
                    translations: [{ languageCode: 'en', name }],
                },
            } as any),
        onSuccess: () => {
            toast.success(t`Group created`);
            queryClient.invalidateQueries({ queryKey: ['pricelist-groups', 'list'] });
            setOpen(false);
            setCode('');
            setName('');
            setPriority(0);
        },
        onError: err => {
            console.error('[pricelist] createPriceListGroup failed:', err);
            toast.error(t`Failed to create group`);
        },
    });

    const canSubmit = code.trim().length > 0 && name.trim().length > 0;

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger render={
                <Button>
                    <Plus className="h-4 w-4 mr-1" />
                    {t`New Group`}
                </Button>
            } />
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t`New group`}</DialogTitle>
                    <DialogDescription>
                        {t`Groups are channel-local. The new group is created on the active channel.`}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    <div className="space-y-1.5">
                        <Label htmlFor="new-grp-code">{t`Code`}</Label>
                        <Input
                            id="new-grp-code"
                            value={code}
                            onChange={e => setCode(e.target.value)}
                            placeholder={t`e.g. promo`}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="new-grp-name">{t`Name (English)`}</Label>
                        <Input
                            id="new-grp-name"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder={t`e.g. Promotional`}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="new-grp-priority">{t`Priority`}</Label>
                        <Input
                            id="new-grp-priority"
                            type="number"
                            value={priority}
                            onChange={e => setPriority(parseInt(e.target.value, 10) || 0)}
                        />
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
                        {t`Create`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

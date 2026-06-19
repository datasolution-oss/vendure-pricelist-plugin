import { Button } from '@/vdb/components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/vdb/components/ui/dialog.js';
import { Input } from '@/vdb/components/ui/input.js';
import { Label } from '@/vdb/components/ui/label.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/vdb/components/ui/select.js';
import { api } from '@/vdb/graphql/api.js';
import { useUserSettings } from '@/vdb/hooks/use-user-settings.js';
import { useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { createPriceListMutation } from '../gql/mutations';
import type { PriceListValueType } from '../gql/types';

import { TimezoneSelect } from './timezone-select';

/**
 * Minimal "New PriceList" form. The full edit surface lives on the
 * detail page; here we collect just the required fields so the list can
 * be created and the user navigated to its detail page for fuller edit.
 *
 * Why `valueType` is collected at create time (not on detail-edit):
 * `valueType` is a list-wide invariant — it decides how every item's
 * `value` is interpreted, and cannot be safely flipped later without
 * re-deriving every row.
 *
 * Timezone defaults to UTC and is collected here too — it's the zone the
 * `startDate`/`endDate` window (set on the detail page) is interpreted in.
 *
 * The translation row submitted uses the dashboard's active content
 * language (the language picker in the top bar), so "Name" is the name
 * in *that* language — consistent with how every other Vendure entity
 * edit works.
 */
export function CreatePriceListDialog({ onCreated }: Readonly<{ onCreated?: () => void }>) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { settings } = useUserSettings();
  const contentLanguage = settings.contentLanguage;
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [valueType, setValueType] = useState<PriceListValueType>('ABSOLUTE');
  const [timezone, setTimezone] = useState('UTC');

  // Base UI's <SelectValue> renders the raw selected value unless the root is
  // given an `items` map (value -> label); single-sourced here so the trigger
  // label and the dropdown options can't drift.
  const valueTypeLabels: Record<PriceListValueType, string> = {
    ABSOLUTE: t`Fixed prices`,
    PERCENTAGE: t`Percentage discounts`
  };

  const mutation = useMutation({
    mutationFn: () =>
      api.mutate(createPriceListMutation, {
        input: {
          code,
          valueType,
          timezone,
          translations: [{ languageCode: contentLanguage, name }]
        }
      } as any) as Promise<{ createPriceList: { id: string } }>,
    onSuccess: data => {
      toast.success(t`Pricelist created`);
      // Refresh the parent list (in case navigation below is a
      // no-op, e.g. the detail route fails to resolve). The
      // manual queryKey invalidation removed here never matched
      // PaginatedListDataTable's internal cache key anyway.
      onCreated?.();
      setOpen(false);
      setCode('');
      setName('');
      const newId = data?.createPriceList?.id;
      if (newId) {
        navigate({ to: '/pricelists/$id', params: { id: newId } });
      }
    },
    onError: err => {
      console.error('[pricelist] createPriceList failed:', err);
      toast.error(t`Failed to create pricelist`);
    }
  });

  const canSubmit = code.trim().length > 0 && name.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <Plus className="h-4 w-4 mr-1" />
            {t`New Pricelist`}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`New pricelist`}</DialogTitle>
          <DialogDescription>
            {t`Create a pricelist on the active channel. Items, customer access, and additional translations can be added on the detail page.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-pl-code">{t`Code`}</Label>
            <Input
              id="new-pl-code"
              value={code}
              onChange={e => setCode(e.target.value)}
              placeholder={t`e.g. STANDARD-EUR`}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-pl-name">{t`Name`}</Label>
            <Input
              id="new-pl-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t`e.g. Standard EUR Pricelist`}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-pl-value-type">{t`Value type`}</Label>
            <Select
              items={valueTypeLabels}
              value={valueType}
              onValueChange={(v: string | null) => v && setValueType(v as PriceListValueType)}
            >
              <SelectTrigger id="new-pl-value-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(valueTypeLabels) as PriceListValueType[]).map(v => (
                  <SelectItem key={v} value={v}>
                    {valueTypeLabels[v]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t`Cannot be changed after creation.`}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-pl-timezone">{t`Timezone`}</Label>
            <TimezoneSelect id="new-pl-timezone" value={timezone} onChange={setTimezone} />
            <p className="text-xs text-muted-foreground">{t`Zone the validity dates are interpreted in. Editable later.`}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {t`Cancel`}
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!canSubmit || mutation.isPending}>
            {t`Create`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
